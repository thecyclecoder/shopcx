/**
 * Data tools for the Improve tab — delegates to Sonnet v2's shared tool executor.
 * Single source of truth: sonnet-orchestrator-v2.ts executeToolCall()
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { executeToolCall } from "@/lib/sonnet-orchestrator-v2";

type Ticket = { id: string; customer_email?: string; [key: string]: unknown };

async function resolveCustomerId(workspaceId: string, ticket: Ticket): Promise<string> {
  const admin = createAdminClient();
  const { data: t } = await admin.from("tickets").select("customer_id").eq("id", ticket.id).single();
  if (t?.customer_id) return t.customer_id;
  if (ticket.customer_email) {
    const { data: c } = await admin.from("customers").select("id").eq("workspace_id", workspaceId).eq("email", ticket.customer_email).single();
    if (c?.id) return c.id;
  }
  return "";
}

export default async function executeToolCallImprove(
  name: string,
  input: Record<string, unknown>,
  workspaceId: string,
  ticket: Ticket,
): Promise<string> {
  // Admin-side tool: active policies for this workspace. Doesn't need a
  // customer resolved — policies are the workspace's rulebook. Phase 1 of
  // [[../../docs/brain/specs/sol-reviews-policies-and-never-bais-an-out-of-policy-outcome-full-research-session]]
  // gives Sol read-only research over the policies table so her Direction
  // reflects what the workspace actually allows (returns, refunds,
  // consumable / subscription returnability, exception ceilings) instead of
  // guessing. Optional `input.slug` narrows to one policy; the argless form
  // lists every active policy. Returns internal_summary (the rule-body the
  // grader / orchestrator already reads via sonnet-orchestrator-v2:465) so
  // Sol reasons against the same text every other layer sees.
  if (name === "get_policies") {
    const admin = createAdminClient();
    const slugInput = typeof input.slug === "string" ? input.slug.trim() : "";
    let q = admin
      .from("policies")
      .select("slug, name, customer_summary, internal_summary, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true)
      .is("superseded_by", null)
      .order("slug");
    if (slugInput) q = q.eq("slug", slugInput);
    const { data, error } = await q;
    if (error) return `get_policies failed: ${error.message}`;
    const rows = (data ?? []) as Array<{
      slug: string;
      name: string;
      customer_summary: string | null;
      internal_summary: string | null;
      updated_at: string;
    }>;
    if (!rows.length) {
      return slugInput
        ? `No active policy matches slug='${slugInput}' in this workspace.`
        : "No active policies in this workspace.";
    }
    return rows
      .map((p) =>
        [
          `## ${p.name} (slug: ${p.slug})`,
          p.internal_summary ? p.internal_summary.trim() : "(no internal_summary)",
          p.customer_summary ? `\nCustomer-facing summary:\n${p.customer_summary.trim()}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n");
  }

  // Admin-side tool: latest ticket analysis. Doesn't need a customer
  // resolved (some analyses run on tickets without customers).
  if (name === "get_ticket_analysis") {
    const admin = createAdminClient();
    const { data: latest } = await admin.from("ticket_analyses")
      .select("score, admin_score, issues, action_items, summary, model, cost_cents, ai_message_count, window_start, window_end, created_at, trigger")
      .eq("ticket_id", ticket.id)
      .eq("workspace_id", workspaceId)
      .order("window_end", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latest) return "No analysis yet for this ticket.";

    const lines: string[] = [];
    const eff = latest.admin_score ?? latest.score;
    lines.push(`Score: ${eff}/10${latest.admin_score != null ? ` (admin overrode auto score of ${latest.score})` : ""}`);
    lines.push(`Window: ${latest.window_start} → ${latest.window_end}`);
    lines.push(`Trigger: ${latest.trigger || "—"}`);
    lines.push(`AI messages graded: ${latest.ai_message_count}`);
    lines.push(`Cost: $${(((latest.cost_cents as number) || 0) / 100).toFixed(4)}`);
    if (latest.summary) lines.push(`\nSummary: ${latest.summary}`);
    const issues = (latest.issues as Array<{type?: string; description?: string}>) || [];
    if (issues.length) {
      lines.push(`\nIssues:`);
      for (const i of issues) lines.push(`  - [${i.type}] ${i.description}`);
    }
    const actions = (latest.action_items as Array<{priority?: string; description?: string}>) || [];
    if (actions.length) {
      lines.push(`\nAction items:`);
      for (const a of actions) lines.push(`  [${a.priority}] ${a.description}`);
    }
    return lines.join("\n");
  }

  // Account linking is FUNDAMENTAL to ticket handling (CLAUDE.md). Both Sol and June can explicitly
  // pull the graded link candidates for the ticket's customer — a HIGH-confidence unlinked sibling
  // (shared address / phone) means the real sub/order/charge may live on the OTHER account. Ticket
  // db8b3d66 is the wedge (a same-address second account, bulk-rejected, hid an active sub).
  if (name === "get_link_candidates") {
    const admin = createAdminClient();
    const cid = await resolveCustomerId(workspaceId, ticket);
    if (!cid) return "No customer found for this ticket.";
    const { findUnlinkedMatches } = await import("@/lib/account-matching");
    const matches = await findUnlinkedMatches(workspaceId, cid, admin);
    if (!matches.length) return "No unlinked account candidates for this customer.";
    const lines = matches.map(
      (m) =>
        `- ${m.email} — ${m.confidence.toUpperCase()} [${m.signals.join("+")}]${m.previously_rejected ? " (previously dismissed on weaker evidence — re-confirm, don't silently link)" : ""} · id=${m.id}`,
    );
    const anyHigh = matches.some((m) => m.confidence === "high");
    return (
      (anyHigh
        ? "HIGH-confidence match(es) present — check the sibling account's subs/orders/charges before concluding \"no such account/charge\", then PROPOSE linking.\n"
        : "Only low-confidence (name-only) candidates — do NOT link without a stronger signal.\n") + lines.join("\n")
    );
  }

  // Cross-customer order/charge search (CS SDK): find an order by exact amount and/or date window,
  // across EVERY customer in the workspace — the tool for reconciling a "$X charge on <date> with your
  // descriptor" dispute when it isn't on the ticket's own account (it may be on an unlinked sibling).
  // Input: { amount_cents?|amount?, date_from?, date_to?, email? }. Read-only.
  if (name === "search_orders") {
    const admin = createAdminClient();
    const amountCents =
      typeof input.amount_cents === "number"
        ? Math.round(input.amount_cents)
        : typeof input.amount === "number"
          ? Math.round(input.amount * 100)
          : typeof input.amount === "string" && input.amount.trim()
            ? Math.round(parseFloat(input.amount) * 100)
            : null;
    let q = admin
      .from("orders")
      .select("order_number, email, customer_id, total_cents, financial_status, created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (amountCents != null && Number.isFinite(amountCents)) q = q.eq("total_cents", amountCents);
    if (typeof input.date_from === "string" && input.date_from) q = q.gte("created_at", input.date_from);
    if (typeof input.date_to === "string" && input.date_to) q = q.lte("created_at", input.date_to);
    if (typeof input.email === "string" && input.email.trim()) q = q.ilike("email", `%${input.email.trim()}%`);
    const { data, error } = await q;
    if (error) return `search_orders failed: ${error.message}`;
    const rows = (data ?? []) as Array<{ order_number: string; email: string; customer_id: string | null; total_cents: number; financial_status: string; created_at: string }>;
    if (!rows.length) return "No orders match that amount/date/email across the workspace.";
    return rows
      .map((o) => `#${o.order_number} · $${(o.total_cents / 100).toFixed(2)} · ${o.financial_status} · ${o.created_at} · ${o.email} · cid=${o.customer_id ?? "—"}`)
      .join("\n");
  }

  const custId = await resolveCustomerId(workspaceId, ticket);
  // Product-level tools don't need a resolved customer.
  const customerlessTools = new Set(["get_product_knowledge", "get_product_nutrition"]);
  if (!custId && !customerlessTools.has(name)) {
    return "No customer found for this ticket.";
  }
  return executeToolCall(name, input, workspaceId, custId, ticket.id);
}
