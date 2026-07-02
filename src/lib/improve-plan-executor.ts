/**
 * improve-plan-executor — runs an APPROVED Improve action plan server-side (box-ticket-improve P2/P3).
 *
 * The box (Max `claude -p`) only PROPOSES the plan; this executes it once the founder/CX manager
 * approves, in the trusted Vercel runtime (service role + integration + GitHub creds) — the same
 * place today's Improve tab already runs `runImproveActions`. Each plan-action kind maps to an
 * existing executor; nothing here is freestyle DB writes.
 *
 * Order: customer actions + rule proposals (one runImproveActions batch, preserves {{label_url}}
 * chaining) → rescore → ticket_spec commit → resolve_sequence LAST (close after everything lands).
 * See docs/brain/specs/box-ticket-improve.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { runImproveActions, type ImproveAction } from "@/lib/improve-actions";
import type { ImprovePlanAction } from "@/lib/ticket-improve-chats";

/** A code change → a ticket-sourced spec authored to public.specs (owner=cs), surfaced on Roadmap to
 *  commission. retire-md-spec-writers-db-is-sole-spec Phase 1 — authored through the
 *  authorSpecRowStructured chokepoint (DB is the spec), not a docs/brain/specs/{slug}.md commit. */
function ticketSpecFields(
  spec: { title: string; intent: string; problem: string },
  ticketId: string,
): { summary: string; phaseBody: string; phaseVerification: string } {
  const summary = [
    `**Derived-from-ticket:** \`${ticketId}\``,
    ``,
    spec.intent.trim(),
    ``,
    `## Problem (from ticket \`${ticketId}\`)`,
    spec.problem.trim(),
    ``,
    `> Authored by the box Improve agent from ticket \`${ticketId}\`. Commission the build from the Roadmap board (owner = cs).`,
  ].join("\n");
  const phaseBody = [
    `Implement the fix scoped from the problem above.`,
    ``,
    `Land the code change + the matching brain page in the SAME PR (CLAUDE.md hard rule).`,
  ].join("\n");
  const phaseVerification = `Reproduce the ticket scenario → confirm the fixed behavior, and that the ticket that surfaced it (\`${ticketId}\`) would now be handled correctly. \`npx tsc --noEmit\` clean.`;
  return { summary, phaseBody, phaseVerification };
}

export interface ExecutePlanResult {
  actions: ImprovePlanAction[];
  results: string[];
  resolved: boolean; // true if a resolve_sequence closed the ticket
}

/**
 * Execute the approved actions of a plan against `ticketId`. Declined/non-approved actions are left
 * untouched. Returns the actions with updated status/result + a flat result log + whether the ticket
 * was closed by a resolve_sequence (so the session can flip to 'resolved').
 */
export async function executeImprovePlan(
  workspaceId: string,
  ticketId: string,
  actions: ImprovePlanAction[],
): Promise<ExecutePlanResult> {
  const admin = createAdminClient();
  const results: string[] = [];
  let resolved = false;

  // 1. Batch the customer actions + rule proposals through runImproveActions (preserves chaining +
  //    its single internal results note). Map each plan-action kind to an ImproveAction.
  const batch: { ref: ImprovePlanAction; action: ImproveAction }[] = [];
  for (const a of actions) {
    if (a.status !== "approved") continue;
    if (a.kind === "customer_action" && a.action) {
      batch.push({ ref: a, action: a.action });
    } else if (a.kind === "sonnet_prompt" && a.prompt) {
      batch.push({ ref: a, action: { type: "propose_sonnet_prompt", title: a.prompt.title, content: a.prompt.content, category: a.prompt.category || "rule" } });
    } else if (a.kind === "grader_rule" && a.rule) {
      batch.push({ ref: a, action: { type: "propose_grader_rule", title: a.rule.title, content: a.rule.content } });
    }
  }
  if (batch.length) {
    const { results: batchResults } = await runImproveActions(workspaceId, ticketId, batch.map((b) => b.action));
    batch.forEach((b, i) => {
      b.ref.status = "done";
      b.ref.result = batchResults[i] || "done";
    });
    results.push(...batchResults);
  }

  // 1b. Orchestrator actions — drive the FULL production executor
  //     (executeSonnetDecision) exactly as the orchestrator does, so Improve
  //     can launch a journey/playbook/workflow/macro, escalate, or fire any
  //     direct action with production-correct portal/email/chat/sms delivery.
  //     Same code path as scripts/apply-coupon-via-executor.ts, one-off →
  //     server-side. See docs/brain/specs/improve-orchestrator-action-parity.md.
  const orchestratorActions = actions.filter((a) => a.status === "approved" && a.kind === "orchestrator_action" && a.decision);
  if (orchestratorActions.length) {
    const { executeSonnetDecision } = await import("@/lib/action-executor");
    const { deliverTicketMessage } = await import("@/lib/ticket-delivery");
    const { data: t } = await admin.from("tickets").select("customer_id, channel").eq("id", ticketId).single();
    const { data: ws } = await admin.from("workspaces").select("sandbox_mode").eq("id", workspaceId).single();
    const sandbox = ws?.sandbox_mode === true;
    for (const a of orchestratorActions) {
      if (!t?.customer_id) {
        a.status = "failed";
        a.result = "orchestrator_action: no customer on ticket";
        results.push(a.result);
        continue;
      }
      try {
        const ctx = {
          admin,
          workspaceId,
          ticketId,
          customerId: t.customer_id,
          channel: t.channel || "email",
          sandbox,
        };
        // send: deliver the decision's response_message on the ticket's channel
        // (portal-aware). Journeys/playbooks/workflows self-deliver; this is the
        // sink for direct_action / escalate / kb_response / ai_response / macro
        // messages and the journey-launch-failed fallback.
        const send = async (msg: string, sb: boolean) => {
          await deliverTicketMessage(admin, workspaceId, ticketId, ctx.channel, msg, sb);
        };
        const sysNote = async (msg: string) => {
          await admin.from("ticket_messages").insert({
            ticket_id: ticketId, direction: "outbound", visibility: "internal", author_type: "system", body: msg,
          });
        };
        // Audit trail (North star: the tool surfaces its reasoning) — log the
        // decision + reasoning the operator approved before it runs.
        await sysNote(`[Improve] Running orchestrator action ${a.decision!.action_type}${a.decision!.handler_name ? ` "${a.decision!.handler_name}"` : ""}. Reasoning: ${a.decision!.reasoning || "(none)"}`);
        const r = await executeSonnetDecision(ctx, a.decision!, null, send, sysNote);
        a.status = "done";
        a.result = `Ran ${a.decision!.action_type}${a.decision!.handler_name ? ` "${a.decision!.handler_name}"` : ""}` +
          `${r.messageSent ? " — message delivered" : ""}${r.escalated ? " — escalated" : ""}${r.closed ? " — ticket closed" : ""}`;
        if (r.closed) resolved = true;
      } catch (e) {
        a.status = "failed";
        a.result = `orchestrator_action failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      results.push(a.result);
    }
  }

  // 2. Re-score this ticket (force a fresh ticket_analyses row).
  for (const a of actions) {
    if (a.status !== "approved" || a.kind !== "rescore") continue;
    try {
      const { analyzeTicket } = await import("@/lib/ticket-analyzer");
      const r = await analyzeTicket(ticketId, "manual");
      a.status = "done";
      a.result = r && typeof r === "object" && "score" in r ? `Re-scored: ${(r as { score?: number }).score}/10` : "Re-analysis triggered";
      results.push(a.result);
    } catch (e) {
      a.status = "failed";
      a.result = `rescore failed: ${e instanceof Error ? e.message : String(e)}`;
      results.push(a.result);
    }
  }

  // 3. Author ticket-sourced spec(s) to public.specs (owner=cs). Never auto-builds — surfaced on
  //    Roadmap. retire-md-spec-writers-db-is-sole-spec Phase 1 — through the authorSpecRowStructured
  //    chokepoint (DB is the spec), not a docs/brain/specs/{slug}.md commit.
  for (const a of actions) {
    if (a.status !== "approved" || a.kind !== "ticket_spec" || !a.spec) continue;
    const slug = a.spec.slug.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    try {
      const { authorSpecRowStructured } = await import("@/lib/author-spec");
      const { summary, phaseBody, phaseVerification } = ticketSpecFields(a.spec, ticketId);
      const authored = await authorSpecRowStructured(
        workspaceId,
        slug,
        {
          title: a.spec.title,
          summary,
          owner: "cs",
          parent: `[[../functions/cs]] — Ticket-derived product fixes`,
          blocked_by: [],
          autoBuild: false, // improve-plan-executor: commission on Roadmap; do NOT auto-build.
          phases: [
            {
              title: `P1 — implement the fix`,
              body: phaseBody,
              verification: phaseVerification,
              status: "planned",
            },
          ],
        },
        "planned",
        { intendedStatusSetBy: "box:ticket-improve" },
      );
      a.status = authored ? "done" : "failed";
      a.result = authored ? `Spec authored: ${slug} (owner=cs) — commission on Roadmap` : `spec author failed for ${slug}`;
    } catch (e) {
      a.status = "failed";
      a.result = `spec author failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    results.push(a.result!);
  }

  // 4. Resolve sequence LAST: post internal note(s) → close → unassign → unescalate.
  for (const a of actions) {
    if (a.status !== "approved" || a.kind !== "resolve_sequence" || !a.resolve) continue;
    try {
      for (const note of a.resolve.internal_notes || []) {
        if (!note?.trim()) continue;
        await admin.from("ticket_messages").insert({
          ticket_id: ticketId,
          direction: "outbound",
          visibility: "internal",
          author_type: "system",
          body: note,
        });
      }
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (a.resolve.close !== false) {
        patch.status = "closed";
        patch.closed_at = new Date().toISOString();
      }
      if (a.resolve.unassign !== false) patch.assigned_to = null;
      if (a.resolve.unescalate !== false) {
        patch.escalated_at = null;
        patch.escalated_to = null;
        patch.escalation_reason = null;
      }
      await admin.from("tickets").update(patch).eq("id", ticketId).eq("workspace_id", workspaceId);
      a.status = "done";
      a.result = `Closeout: ${[a.resolve.internal_notes?.length ? `${a.resolve.internal_notes.length} internal note(s)` : null, patch.status ? "closed" : null, "unassigned" in patch || a.resolve.unassign !== false ? "unassigned" : null, a.resolve.unescalate !== false ? "unescalated" : null].filter(Boolean).join(", ")}`;
      results.push(a.result);
      if (patch.status === "closed") resolved = true;
    } catch (e) {
      a.status = "failed";
      a.result = `resolve_sequence failed: ${e instanceof Error ? e.message : String(e)}`;
      results.push(a.result);
    }
  }

  return { actions, results, resolved };
}
