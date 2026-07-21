/**
 * Inngest functions for the Research & Heal pipeline.
 *
 *   ticket/research.requested   — run one or more recipes against a ticket
 *   ticket/heal.requested       — execute a specific gap's proposed_heal
 */

import { inngest } from "./client";
import { errText } from "@/lib/error-text";
import { createAdminClient } from "@/lib/supabase/admin";
import { runRecipe, getRecipe } from "@/lib/research";
import type { Gap, ProposedHeal } from "@/lib/research/types";
import { directActionHandlers } from "@/lib/action-executor";
import type { ActionContext, ActionParams, ActionResult } from "@/lib/action-executor";
import { sendTicketReply } from "@/lib/email";

export const ticketResearchRequested = inngest.createFunction(
  {
    id: "ticket-research-requested",
    name: "Research & Heal — run recipes on a ticket",
    retries: 2,
    concurrency: [{ limit: 8 }],
    triggers: [{ event: "ticket/research.requested" }],
  },
  async ({ event, step }) => {
    const { ticket_id, recipes, source_analysis_id, triggered_by } = event.data as {
      ticket_id: string;
      recipes: Array<{ slug: string; args?: Record<string, unknown> }>;
      source_analysis_id?: string;
      triggered_by?: "ai_analysis" | "manual";
    };

    const summary: Array<{ slug: string; runId?: string; findings: number; gaps: number; error?: string }> = [];
    for (const r of recipes || []) {
      if (!getRecipe(r.slug)) {
        summary.push({ slug: r.slug, findings: 0, gaps: 0, error: "Unknown recipe slug" });
        continue;
      }
      const result = await step.run(`run:${r.slug}`, async () => runRecipe(r.slug, ticket_id, {
        triggeredBy: triggered_by || "ai_analysis",
        sourceAnalysisId: source_analysis_id || null,
        args: r.args,
      }));
      if ("error" in result) {
        summary.push({ slug: r.slug, findings: 0, gaps: 0, error: result.error });
      } else {
        summary.push({ slug: r.slug, runId: result.runId, findings: result.result.findings.length, gaps: result.result.gaps.length });
      }
    }
    return { ticket_id, recipes_run: summary };
  },
);

export const ticketHealRequested = inngest.createFunction(
  {
    id: "ticket-heal-requested",
    name: "Research & Heal — execute a gap's proposed heal",
    retries: 1,
    concurrency: [{ limit: 4 }],
    triggers: [{ event: "ticket/heal.requested" }],
  },
  async ({ event, step }) => {
    const { ticket_id, research_run_id, gap_id, triggered_by_user_id } = event.data as {
      ticket_id: string;
      research_run_id: string;
      gap_id: string;
      triggered_by_user_id?: string;
    };

    // Inngest's step.run has a Jsonify<T> return type that doesn't satisfy
    // executeHeal's structural typing. We bridge it with a simple identity
    // wrapper — the values are JSON-serializable anyway.
    const stepShim = { run: async <T,>(_name: string, fn: () => Promise<T>) => (await step.run(_name, async () => fn() as unknown)) as unknown as T };
    return executeHeal(ticket_id, research_run_id, gap_id, triggered_by_user_id || null, stepShim);
  },
);

/**
 * Executes one gap's proposed_heal. Shared between the Inngest path
 * (auto / manual queue) and the synchronous API path (one-click button).
 */
export async function executeHeal(
  ticketId: string,
  researchRunId: string,
  gapId: string,
  triggeredByUserId: string | null,
  step?: { run: <T>(name: string, fn: () => Promise<T>) => Promise<T> },
): Promise<{
  ok: boolean;
  status: string;
  heal_attempt_id: string;
  error?: string;
  customer_message_sent?: boolean;
}> {
  const admin = createAdminClient();
  const runStep = step?.run ? step.run.bind(step) : <T>(_n: string, fn: () => Promise<T>) => fn();

  // Load the research run + ticket + gap
  const ctxLoad = await runStep("load-context", async () => {
    const { data: run } = await admin
      .from("ticket_research_runs")
      .select("id, workspace_id, ticket_id, recipe_slug, gaps")
      .eq("id", researchRunId)
      .single();
    if (!run) return { error: "research_run_not_found" } as const;

    const gap = ((run.gaps as Gap[]) || []).find(g => g.gap_id === gapId);
    if (!gap) return { error: "gap_not_found_in_run" } as const;
    if (!gap.proposed_heal) return { error: "gap_has_no_proposed_heal" } as const;

    const { data: ticket } = await admin
      .from("tickets")
      .select("id, workspace_id, customer_id, channel, email_message_id, subject")
      .eq("id", ticketId)
      .single();
    if (!ticket?.customer_id) return { error: "ticket_or_customer_missing" } as const;

    return { run, gap, ticket } as const;
  });

  if ("error" in ctxLoad) {
    return { ok: false, status: "load_failed", heal_attempt_id: "", error: ctxLoad.error };
  }
  const { run, gap, ticket } = ctxLoad;
  const proposed: ProposedHeal = gap.proposed_heal!;

  // 1. Idempotency: prior successful heal for this gap?
  const idempotencyCheck = await runStep("idempotency", async () => {
    const { data: prior } = await admin
      .from("ticket_heal_attempts")
      .select("id, status")
      .eq("ticket_id", ticketId)
      .eq("gap_id", gapId)
      .in("status", ["executed", "verified_closed"])
      .limit(1)
      .maybeSingle();
    return prior;
  });
  if (idempotencyCheck) {
    return { ok: true, status: "skipped_idempotent", heal_attempt_id: idempotencyCheck.id as string };
  }

  // Insert a pending heal_attempt row up front
  const { data: attempt } = await admin
    .from("ticket_heal_attempts")
    .insert({
      workspace_id: ticket.workspace_id,
      ticket_id: ticketId,
      research_run_id: researchRunId,
      gap_id: gapId,
      recipe_slug: run.recipe_slug,
      action_type: proposed.action_type,
      action_params: proposed.params,
      status: "pending",
      attempted_by: triggeredByUserId,
    })
    .select("id")
    .single();
  const attemptId = attempt?.id as string;

  // 2. Re-run the recipe to confirm the gap still exists
  const reverify = await runStep("reverify-gap", async () => {
    const r = await runRecipe(run.recipe_slug, ticketId, { triggeredBy: "heal_reverify" });
    if ("error" in r) return { stillExists: true, runId: null, error: r.error };
    const stillExists = r.result.gaps.some(g => g.gap_id === gapId);
    return { stillExists, runId: r.runId, error: null };
  });
  if (!reverify.stillExists) {
    await admin.from("ticket_heal_attempts").update({ status: "verified_existing", result: { reverify } }).eq("id", attemptId);
    return { ok: true, status: "skipped_already_closed", heal_attempt_id: attemptId };
  }

  // 3. Execute the proposed direct_action
  const exec = await runStep("execute-action", async () => {
    return executeActionByName(proposed.action_type, ticket.workspace_id, ticket.customer_id!, ticketId, proposed.params);
  });
  if (!exec.success) {
    await admin.from("ticket_heal_attempts").update({ status: "failed", error: exec.error || "action_failed", result: exec as unknown as Record<string, unknown> }).eq("id", attemptId);
    return { ok: false, status: "failed", heal_attempt_id: attemptId, error: exec.error || "Action returned success=false" };
  }
  await admin.from("ticket_heal_attempts").update({ status: "executed", result: exec as unknown as Record<string, unknown> }).eq("id", attemptId);

  // 4. Re-verify the gap closed
  const postCheck = await runStep("post-heal-reverify", async () => {
    const r = await runRecipe(run.recipe_slug, ticketId, { triggeredBy: "heal_reverify" });
    if ("error" in r) return { closed: false, runId: null };
    const stillThere = r.result.gaps.some(g => g.gap_id === gapId);
    return { closed: !stillThere, runId: r.runId };
  });
  if (!postCheck.closed) {
    await admin.from("ticket_heal_attempts").update({ status: "verified_still_open" }).eq("id", attemptId);
    return { ok: false, status: "verified_still_open", heal_attempt_id: attemptId, error: "Gap persisted after heal" };
  }

  // 5. Send the customer follow-up message
  const customerMessageSent = await runStep("send-customer-message", async () => {
    return sendHealFollowUp(admin, ticket, proposed, exec);
  });
  await admin.from("ticket_heal_attempts").update({
    status: "verified_closed",
    customer_message_sent: customerMessageSent.sent,
    customer_message_body: customerMessageSent.body || null,
  }).eq("id", attemptId);

  // 6. Unescalate + close
  await runStep("unescalate-and-close", async () => {
    await admin.from("tickets").update({
      status: "closed",
      escalated_to: null,
      escalation_reason: null,
      updated_at: new Date().toISOString(),
    }).eq("id", ticketId);
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[Heal] gap "${gapId}" closed via ${proposed.action_type}. Customer notified. Ticket auto-closed.`,
    });
  });

  return { ok: true, status: "verified_closed", heal_attempt_id: attemptId, customer_message_sent: customerMessageSent.sent };
}

// ────────────────────────────────────────────────────────────────────────
// Action executor wrapper — invokes a directAction by name with the
// proper context shape.
// ────────────────────────────────────────────────────────────────────────
async function executeActionByName(
  actionType: string,
  workspaceId: string,
  customerId: string,
  ticketId: string,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const admin = createAdminClient();
  const handler = (directActionHandlers as Record<string, (ctx: ActionContext, p: ActionParams) => Promise<ActionResult>>)[actionType];
  if (!handler) {
    return { success: false, error: `Unknown direct action: ${actionType}` } as ActionResult;
  }
  const ctx: ActionContext = {
    admin,
    workspaceId,
    customerId,
    ticketId,
    channel: "email",
    sandbox: false,
  };
  try {
    return await handler(ctx, params as unknown as ActionParams);
  } catch (err) {
    return { success: false, error: errText(err) } as ActionResult;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Customer follow-up sender
// ────────────────────────────────────────────────────────────────────────
async function sendHealFollowUp(
  admin: ReturnType<typeof createAdminClient>,
  ticket: { id: string; workspace_id: string; customer_id: string | null; channel: string | null; email_message_id: string | null; subject: string | null },
  proposed: ProposedHeal,
  execResult: ActionResult,
): Promise<{ sent: boolean; body: string | null }> {
  if (!proposed.customer_message_template) return { sent: false, body: null };

  // Fill placeholders from execResult + proposed.params
  const subs: Record<string, string> = {};
  const params = proposed.params as Record<string, unknown>;
  if (typeof params.coupon_code === "string") subs.coupon_code = params.coupon_code;
  if (typeof params.contract_id === "string") subs.contract_id = params.contract_id;
  if (typeof params.variant_title === "string") subs.variant_title = params.variant_title;
  if (typeof params.interval === "string") subs.interval = params.interval.toLowerCase();
  if (typeof params.interval_count === "number") subs.interval_count = String(params.interval_count);
  if (typeof params.date === "string") subs.next_date = formatFriendlyDate(params.date);
  // {{value}} renders as the customer-paid per-unit price — base * 0.75
  // since Appstle applies the 25% sellingPlan discount at renewal.
  // Customers should see their actual paid amount, not the internal base.
  if (typeof params.base_price_cents === "number") {
    subs.value = (params.base_price_cents * 0.75 / 100).toFixed(2);
  }
  // Direct actions often surface generated values on the result
  const er = execResult as ActionResult & { couponCode?: string; discount_value?: number };
  if (er.couponCode) subs.coupon_code = er.couponCode;
  // tier_index → discount_value mapping (rough — most heals are $15 tier)
  if (typeof params.tier_index === "number") {
    const tierValues = [5, 10, 15];
    subs.discount_value = String(tierValues[params.tier_index] ?? 15);
  }
  if (er.discount_value != null) subs.discount_value = String(er.discount_value);

  let body = proposed.customer_message_template;
  for (const [k, v] of Object.entries(subs)) {
    body = body.split(`{{${k}}}`).join(v);
  }
  // Strip any unsubstituted placeholders
  body = body.replace(/\{\{[^}]+\}\}/g, "").replace(/\s+/g, " ").trim();

  const persona = proposed.customer_message_persona || "suzie";
  const personaName = persona === "julie" ? "Julie" : "Suzie";

  if (ticket.channel === "email") {
    const { data: cust } = await admin.from("customers").select("email").eq("id", ticket.customer_id!).single();
    const { data: ws } = await admin.from("workspaces").select("name").eq("id", ticket.workspace_id).single();
    if (!cust?.email) return { sent: false, body };
    const r = await sendTicketReply({
      workspaceId: ticket.workspace_id,
      toEmail: cust.email,
      subject: ticket.subject || "Update on your ticket",
      body: `<p>${body}</p><p>Best,<br>${personaName}<br>${ws?.name || "Superfoods Company"}</p>`,
      inReplyTo: ticket.email_message_id || null,
      agentName: personaName,
      workspaceName: ws?.name || "Superfoods Company",
    });
    await admin.from("ticket_messages").insert({
      ticket_id: ticket.id,
      direction: "outbound",
      visibility: "external",
      author_type: persona === "julie" ? "agent" : "ai",
      body: `<p>${body}</p><p>Best,<br>${personaName}</p>`,
      body_clean: `${body} Best, ${personaName}`,
      resend_email_id: r.messageId || null,
    });
    return { sent: !r.error, body };
  }

  // Chat channel — insert directly; widget polls for outbound messages.
  await admin.from("ticket_messages").insert({
    ticket_id: ticket.id,
    direction: "outbound",
    visibility: "external",
    author_type: persona === "julie" ? "agent" : "ai",
    body: `<p>${body}</p>`,
    body_clean: body,
  });
  return { sent: true, body };
}

function formatFriendlyDate(iso: string): string {
  const t = iso.length >= 10 ? new Date(`${iso.slice(0, 10)}T00:00:00`) : new Date(iso);
  if (isNaN(t.getTime())) return iso;
  return t.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}
