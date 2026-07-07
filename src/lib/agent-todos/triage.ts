/**
 * Box-hosted escalation triage — the deterministic substrate behind the hourly solver→skeptic→quorum
 * sweep (box-escalation-triage). The Solver and Skeptic are two separate Max `claude -p` sessions the
 * worker orchestrates (scripts/builder-worker.ts → runEscalationTriageJob); THIS module owns everything
 * around them: which tickets to sweep, the read-only context brief baked into the solver prompt, and —
 * once the two passes reach quorum — materializing the agreed outputs.
 *
 * North star (supervisable autonomy): nothing here mutates a customer. The box only PRODUCES
 * human-gated proposals:
 *   - customer fixes  → `pending` agent_todos (existing dashboard approval + Inngest executor)
 *   - rule changes    → `proposed` sonnet_prompts (admin/Zach approves)
 *   - code/analyzer   → committed docs/brain/specs/*.md (owner=cs, surfaced on Roadmap to commission)
 *   - re-score        → a `ticket_analysis_rescore` agent_todo
 * No quorum → nothing is materialized; the ticket stays escalated and the disagreement is logged in
 * triage_runs for a human. See docs/brain/specs/box-escalation-triage.md.
 */
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildPreExecContext } from "./execute";
import type { AgentTodoActionType, AgentTodoUrgency } from "./constants";
import { proposePrompt } from "@/lib/sonnet-prompts-table";

type Admin = ReturnType<typeof createAdminClient>;

/** The four action types a box-produced agent_todo may carry (post-prune). */
const TRIAGE_TODO_ACTION_TYPES: AgentTodoActionType[] = [
  "customer_reply",
  "customer_action",
  "ticket_close",
  "ticket_analysis_rescore",
];

/** Solver decision taxonomy (mirrors the retired reasoning pass + the spec's per-ticket branches). */
export type TriageDecision =
  | "customer_fix"
  | "escalation_false_positive"
  | "analysis_gap"
  | "system_gap"
  | "no_action";

export interface TriageTodo {
  action_type: AgentTodoActionType;
  summary: string;
  payload: Record<string, unknown>;
  urgency?: AgentTodoUrgency;
  confidence?: number;
}

/** A ticket-derived spec (analyzer/code fix) the solver wants to commission on Roadmap. */
export interface TriageSpec {
  slug: string;
  title: string;
  /** One-paragraph intent tying the fix to the ticket. */
  intent: string;
  /** The concrete problem, grounded in the ticket. */
  problem: string;
  /** Optional concrete target (e.g. "src/lib/ticket-analyzer.ts SEVERE_ISSUE_TYPES"). */
  target?: string;
}

export interface TriageSonnetPrompt {
  title: string;
  category?: "rule" | "approach" | "tool_hint" | "personality" | "knowledge";
  content: string;
}

/** The structured proposal the Solver emits (parsed from its final JSON message). */
export interface SolverProposal {
  decision: TriageDecision;
  reasoning?: string;
  context_what_happened?: string;
  context_what_we_propose?: string;
  urgency?: AgentTodoUrgency;
  /** customer_fix / no_action / analysis_gap → the human-gated todos to materialize. */
  todos?: TriageTodo[];
  /** escalation_false_positive / system_gap → a ticket-derived spec to commit (owner=cs). */
  spec?: TriageSpec;
  /** Optional rule change → a proposed sonnet_prompt (admin-approvable). */
  sonnet_prompt?: TriageSonnetPrompt;
}

/** The Skeptic's adversarial verdict. */
export interface SkepticVerdict {
  verdict: "agree" | "revise" | "reject";
  critique?: string;
  concerns?: string[];
}

// ── Selection + dedupe ──────────────────────────────────────────────────────

export interface TriageSelection {
  selected: string[]; // ticket ids to process this sweep (≤ cap)
  deferred: number; // eligible tickets left for a later sweep (logged, never silently dropped)
  eligible: number; // total eligible after dedupe
}

/**
 * Routine-owned escalated tickets needing triage: escalated_at IS NOT NULL AND escalated_to IS NULL
 * (the analyzer routed them to the routine, not a human), not archived/closed, AND not already
 * covered. Dedupe drops a ticket when:
 *   - it has an active agent_todos group (pending/approved/executed) — one active group per ticket, OR
 *   - a prior triage_run already MATERIALIZED an outcome (spec committed / prompt proposed), OR
 *   - it has already had MAX_NO_QUORUM_ATTEMPTS no-quorum runs (give up; leave for a human).
 */
export async function selectEscalatedForTriage(
  admin: Admin,
  workspaceId: string,
  cap: number,
  maxNoQuorumAttempts = 1, // CEO directive: one triage attempt, then leave the ticket for a human (was 3)
): Promise<TriageSelection> {
  const { data: tickets } = await admin
    .from("tickets")
    .select("id")
    .eq("workspace_id", workspaceId)
    .not("escalated_at", "is", null)
    .is("escalated_to", null)
    .not("status", "in", '("archived","closed")')
    .order("escalated_at", { ascending: true });
  const ids = (tickets || []).map((t) => t.id as string);
  if (!ids.length) return { selected: [], deferred: 0, eligible: 0 };

  // Active agent_todos group → skip (dedupe, matches the retired routine's filter).
  const { data: activeTodos } = await admin
    .from("agent_todos")
    .select("source_ticket_id")
    .in("source_ticket_id", ids)
    .in("status", ["pending", "approved", "executed"]);
  const hasActiveGroup = new Set((activeTodos || []).map((t) => t.source_ticket_id as string));

  // Prior triage_runs → skip if materialized, or count no-quorum attempts toward the give-up cap.
  const { data: priorRuns } = await admin
    .from("triage_runs")
    .select("ticket_id, materialized")
    .in("ticket_id", ids);
  const materialized = new Set<string>();
  const noQuorumCount = new Map<string, number>();
  for (const r of priorRuns || []) {
    const tid = r.ticket_id as string;
    if (r.materialized) materialized.add(tid);
    else noQuorumCount.set(tid, (noQuorumCount.get(tid) || 0) + 1);
  }

  const eligible = ids.filter(
    (id) =>
      !hasActiveGroup.has(id) &&
      !materialized.has(id) &&
      (noQuorumCount.get(id) || 0) < maxNoQuorumAttempts,
  );
  return { selected: eligible.slice(0, cap), deferred: Math.max(0, eligible.length - cap), eligible: eligible.length };
}

/** Resolve a real human to hand a ticket up to — workspace owner, else any admin/agent. */
async function resolveWorkspaceHuman(admin: Admin, workspaceId: string): Promise<string | null> {
  const { data } = await admin
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", workspaceId)
    .in("role", ["owner", "admin", "agent"]);
  const rows = (data || []) as { user_id: string; role: string }[];
  return rows.find((r) => r.role === "owner")?.user_id || rows[0]?.user_id || null;
}

/**
 * No-quorum hand-up. A routine-owned escalated ticket (escalated_at set, escalated_to null) that has
 * hit `maxNoQuorumAttempts` no-quorum triage runs without ever materializing an outcome is genuinely
 * stuck — the routine can't resolve it. Hand it UP to a real human: set `escalated_to` to the
 * workspace owner so it leaves the routine pool (selectEscalatedForTriage requires escalated_to IS
 * NULL) and surfaces in the human escalation queue. Keeps escalated_at; appends the give-up note to
 * escalation_reason. Idempotent — once escalated_to is set the ticket no longer matches. Returns the
 * ids handed up.
 */
export async function handUpExhaustedTriage(
  admin: Admin,
  workspaceId: string,
  maxNoQuorumAttempts = 3,
): Promise<string[]> {
  const { data: tickets } = await admin
    .from("tickets")
    .select("id, escalation_reason")
    .eq("workspace_id", workspaceId)
    .not("escalated_at", "is", null)
    .is("escalated_to", null)
    .not("status", "in", '("archived","closed")');
  const rows = (tickets || []) as { id: string; escalation_reason: string | null }[];
  if (!rows.length) return [];
  const ids = rows.map((t) => t.id);

  const { data: activeTodos } = await admin
    .from("agent_todos")
    .select("source_ticket_id")
    .in("source_ticket_id", ids)
    .in("status", ["pending", "approved", "executed"]);
  const active = new Set((activeTodos || []).map((t) => t.source_ticket_id as string));

  const { data: priorRuns } = await admin
    .from("triage_runs")
    .select("ticket_id, materialized")
    .in("ticket_id", ids);
  const materialized = new Set<string>();
  const noQuorumCount = new Map<string, number>();
  for (const r of priorRuns || []) {
    const tid = r.ticket_id as string;
    if (r.materialized) materialized.add(tid);
    else noQuorumCount.set(tid, (noQuorumCount.get(tid) || 0) + 1);
  }

  const stuck = rows.filter(
    (t) => !active.has(t.id) && !materialized.has(t.id) && (noQuorumCount.get(t.id) || 0) >= maxNoQuorumAttempts,
  );
  if (!stuck.length) return [];

  const human = await resolveWorkspaceHuman(admin, workspaceId);
  if (!human) return []; // no human to hand to — leave escalated to the routine

  const now = new Date().toISOString();
  const handed: string[] = [];
  for (const t of stuck) {
    const reason = `${t.escalation_reason ? `${t.escalation_reason} · ` : ""}AI Routine reached no quorum after ${maxNoQuorumAttempts} attempts — handed to a human.`;
    await admin.from("tickets").update({ escalated_to: human, escalation_reason: reason, updated_at: now }).eq("id", t.id);
    handed.push(t.id);
  }
  return handed;
}

// ── Context brief (baked into the solver prompt) ─────────────────────────────

/** The live conversation rules the orchestrator actually reads every turn (status=approved, enabled). */
async function loadLiveRules(admin: Admin, workspaceId: string): Promise<string> {
  const { data } = await admin
    .from("sonnet_prompts")
    .select("category, title, content")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true)
    .eq("status", "approved")
    .order("category")
    .order("sort_order");
  if (!data?.length) return "(no active sonnet_prompts rules)";
  return data
    .map((p) => `- [${p.category}] ${p.title}: ${String(p.content || "").replace(/\s+/g, " ").slice(0, 400)}`)
    .join("\n");
}

/**
 * Full read-only context brief for ONE escalated ticket: messages, customer + subs + recent orders,
 * the latest ticket_analyses, and the live rules. Baked into the solver prompt so its first pass
 * already references this exact ticket — the solver can pull deeper data via improve-box-tools.ts.
 */
export async function loadTriageBrief(admin: Admin, workspaceId: string, ticketId: string): Promise<string> {
  const { data: ticket } = await admin
    .from("tickets")
    .select("id, subject, channel, status, tags, escalation_reason, escalated_at, ai_turn_count, customer_id")
    .eq("id", ticketId)
    .single();
  if (!ticket) return `Ticket ${ticketId} not found.`;

  const lines: string[] = [];
  lines.push(`TICKET ${ticketId}`);
  lines.push(`Subject: ${ticket.subject || "(none)"}`);
  lines.push(
    `Channel: ${ticket.channel} · Status: ${ticket.status} · AI turns: ${ticket.ai_turn_count || 0} · Tags: ${(ticket.tags || []).join(", ") || "none"}`,
  );
  lines.push(`Escalation reason: ${ticket.escalation_reason || "(none)"}`);

  if (ticket.customer_id) {
    const { data: cust } = await admin
      .from("customers")
      .select("id, first_name, last_name, email, subscription_status, retention_score")
      .eq("id", ticket.customer_id)
      .single();
    if (cust) {
      lines.push(
        `Customer: ${cust.first_name || ""} ${cust.last_name || ""} <${cust.email || ""}> (id ${ticket.customer_id}) · Sub: ${cust.subscription_status || "none"} · Retention: ${cust.retention_score ?? 0}`,
      );
    }

    const { data: subs } = await admin
      .from("subscriptions")
      .select("id, shopify_contract_id, status, items, billing_interval, billing_interval_count, next_billing_date")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", ticket.customer_id);
    if (subs?.length) {
      lines.push("SUBSCRIPTIONS (use the internal id as contract_id; the executor resolves it):");
      for (const s of subs) {
        const items = (s.items as Array<{ title?: string; variant_id?: string; quantity?: number }> | null) || [];
        const itemStr = items.map((i) => `${i.title || "?"}${i.variant_id ? ` (variant ${i.variant_id})` : ""} x${i.quantity ?? 1}`).join(", ");
        lines.push(`  - sub ${s.id} [${s.status}] every ${s.billing_interval_count} ${s.billing_interval}, next ${s.next_billing_date}: ${itemStr}`);
      }
    }

    const { data: orders } = await admin
      .from("orders")
      .select("order_number, shopify_order_id, total_cents, financial_status, created_at")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", ticket.customer_id)
      .order("created_at", { ascending: false })
      .limit(5);
    if (orders?.length) {
      lines.push("RECENT ORDERS:");
      for (const o of orders) {
        lines.push(`  - #${o.order_number} (shopify ${o.shopify_order_id}) $${((o.total_cents || 0) / 100).toFixed(2)} ${o.financial_status} ${o.created_at?.slice(0, 10)}`);
      }
    }

    // Overcharge detection — surface the {charged, expected, delta, dropped_base}
    // signal + remediation plan so the solver CHECKS for an overcharge before
    // proposing create_return / cancel on a billing complaint.
    try {
      const { detectOverchargesForCustomer, formatOverchargeForAgent } = await import("@/lib/subscription-overcharge");
      const overcharges = await detectOverchargesForCustomer(workspaceId, ticket.customer_id);
      if (overcharges.length) {
        lines.push("");
        lines.push(overcharges.map(formatOverchargeForAgent).join("\n"));
      }
    } catch (e) {
      console.error("[triage] overcharge detection failed (non-fatal):", e);
    }
  }

  const { data: analysis } = await admin
    .from("ticket_analyses")
    .select("id, score, summary, issues")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (analysis) {
    lines.push(`LATEST ANALYSIS (id ${analysis.id}): score ${analysis.score}/10 — ${analysis.summary || ""}`);
    lines.push(`  issues: ${JSON.stringify(analysis.issues || [])}`);
  } else {
    lines.push("LATEST ANALYSIS: none.");
  }

  const { data: messages } = await admin
    .from("ticket_messages")
    .select("author_type, direction, visibility, body, created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true })
    .limit(60);
  lines.push("");
  lines.push("CONVERSATION:");
  for (const m of messages || []) {
    const prefix = m.author_type === "ai" ? "[AI]" : m.author_type === "system" ? "[System]" : m.direction === "inbound" ? "[Customer]" : "[Agent]";
    const vis = m.visibility === "internal" ? " (internal note)" : "";
    lines.push(`${prefix}${vis}: ${String(m.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600)}`);
  }

  lines.push("");
  lines.push("LIVE CONVERSATION RULES (sonnet_prompts the orchestrator reads every turn):");
  lines.push(await loadLiveRules(admin, workspaceId));
  return lines.join("\n");
}

// ── Materialization (worker runs this AFTER quorum) ──────────────────────────

/** Build the structured summary + phase body for a ticket-derived spec authored through the
 *  authorSpecRowStructured chokepoint (retire-md-spec-writers-db-is-sole-spec Phase 1). */
function triageSpecFields(spec: TriageSpec, ticketId: string): { summary: string; phaseBody: string; phaseVerification: string } {
  const summary = [
    `**Derived-from-ticket:** \`${ticketId}\``,
    ``,
    spec.intent.trim(),
    ``,
    `## Problem (from escalated ticket \`${ticketId}\`)`,
    spec.problem.trim(),
    spec.target ? `\n**Likely target:** \`${spec.target}\`` : ``,
    ``,
    `> Authored by the box escalation-triage routine (solver+skeptic quorum) from escalated ticket \`${ticketId}\`. Commission the build from the Roadmap board (owner = cs).`,
  ]
    .filter((l) => l !== "")
    .join("\n");
  const phaseBody = [
    `Implement the fix scoped from the problem above.`,
    ``,
    `Land the code change + the matching brain page in the SAME PR (CLAUDE.md hard rule).`,
    ``,
    spec.target ? `Likely target: \`${spec.target}\`.` : ``,
  ]
    .filter((l) => l !== "")
    .join("\n");
  const phaseVerification = `Reproduce the escalation scenario → confirm the corrected behavior, and that the ticket that surfaced it (\`${ticketId}\`) would now be handled (or not mis-escalated). \`npx tsc --noEmit\` clean.`;
  return { summary, phaseBody, phaseVerification };
}

export interface MaterializeResult {
  summary: string;
  groupId?: string;
  /** How many agent_todos were inserted (0 if the outcome was a spec / prompt only). */
  todoCount: number;
  specPath?: string;
  promptId?: string;
}

/**
 * Post an internal ([AI Investigation]) note onto a ticket's thread — the paper trail the routine
 * leaves so a human reading the ticket sees the AI took (or is taking) a stab and can still step in.
 * Internal-only (visibility='internal'), never customer-visible; matches the sysNote shape used by the
 * unified ticket handler. See docs/brain/specs/ai-investigation-ticket-visibility.md.
 */
export async function postTriageNote(admin: Admin, ticketId: string, body: string): Promise<void> {
  await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body,
  });
}

/**
 * Materialize a quorum-agreed solver proposal. Customer fixes / re-score / close → `pending`
 * agent_todos; a proposed rule → `proposed` sonnet_prompts; a code/analyzer fix → a committed spec.
 * The worker calls this only after the skeptic agrees. `triageRunId` ties materialized todos back to
 * the audit row (agent_todos.routine_run_id).
 */
export async function materializeTriageOutcome(
  admin: Admin,
  opts: { workspaceId: string; ticketId: string; proposal: SolverProposal; triageRunId: string },
): Promise<MaterializeResult> {
  const { workspaceId, ticketId, proposal } = opts;
  const parts: string[] = [];
  const out: MaterializeResult = { summary: "", todoCount: 0 };

  // 1. agent_todos group (customer_fix / no_action / analysis_gap).
  // The triage LLM sometimes emits a customer_reply body under `response_message` (the orchestrator's
  // key) instead of the agent_todos standard `body_html` — which the UI preview + the executor BOTH read.
  // Normalize so the reply renders AND can actually send (plain text → <p> paragraphs, no markdown).
  const normalizeReplyPayload = (actionType: string, payload: Record<string, unknown>): Record<string, unknown> => {
    if (actionType !== "customer_reply") return payload;
    if (typeof payload.body_html === "string" && payload.body_html.trim()) return payload;
    const msg = typeof payload.response_message === "string" ? payload.response_message.trim() : "";
    if (!msg) return payload;
    const body_html = /<[a-z][\s\S]*>/i.test(msg) ? msg : msg.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
    return { ...payload, body_html };
  };
  const validTodos = (proposal.todos || []).filter((t) => TRIAGE_TODO_ACTION_TYPES.includes(t.action_type));
  if (validTodos.length) {
    const groupId = randomUUID();
    const pre = await buildPreExecContext(admin, ticketId);
    const now = new Date().toISOString();
    const rows = validTodos.map((t) => ({
      workspace_id: workspaceId,
      source: "ticket",
      source_ticket_id: ticketId,
      group_id: groupId,
      action_type: t.action_type,
      payload: normalizeReplyPayload(t.action_type, t.payload || {}),
      summary: t.summary,
      context_what_happened: proposal.context_what_happened || null,
      context_what_we_propose: proposal.context_what_we_propose || null,
      pre_exec_context: pre,
      confidence: typeof t.confidence === "number" ? t.confidence : null,
      urgency: t.urgency || proposal.urgency || "normal",
      status: "pending",
      routine_run_id: opts.triageRunId,
      created_at: now,
      updated_at: now,
    }));
    const { error } = await admin.from("agent_todos").insert(rows);
    if (error) parts.push(`agent_todos insert failed: ${error.message}`);
    else {
      out.groupId = groupId;
      out.todoCount = rows.length;
      parts.push(`${rows.length} agent_todo(s) [${validTodos.map((t) => t.action_type).join(", ")}] (group ${groupId.slice(0, 8)})`);
    }
  }

  // 2. Proposed sonnet_prompt rule (admin/Zach approves) — mirrors improve-actions propose_sonnet_prompt.
  //    sonnet-prompts-sdk-for-review-agent-db-access Phase 1 — routed through the SDK
  //    ([[../sonnet-prompts-table]]).
  if (proposal.sonnet_prompt?.title && proposal.sonnet_prompt.content) {
    const sp = proposal.sonnet_prompt;
    const { id, error } = await proposePrompt(admin, {
      workspaceId,
      title: sp.title,
      content: sp.content,
      category: sp.category || "rule",
      derivedFromTicketId: ticketId,
    });
    if (error) parts.push(`sonnet_prompt propose failed: ${error}`);
    else {
      out.promptId = id as string;
      parts.push(`proposed sonnet_prompt "${sp.title}" (admin-approvable)`);
    }
  }

  // 3. Ticket-derived spec authored to public.specs (escalation_false_positive / system_gap) — owner=cs.
  //    retire-md-spec-writers-db-is-sole-spec Phase 1 — author THROUGH the authorSpecRowStructured
  //    chokepoint (a real public.specs row + spec_phases). The DB is the spec; the old get-then-PUT
  //    of docs/brain/specs/{slug}.md wrote an ORPHAN .md the build pipeline couldn't see.
  if (proposal.spec?.slug && proposal.spec.title) {
    const slug = proposal.spec.slug.replace(/[^a-z0-9-]/gi, "-").toLowerCase().replace(/^-+|-+$/g, "").slice(0, 60);
    try {
      const { authorSpecRowStructured } = await import("@/lib/author-spec");
      const { summary: specSummary, phaseBody, phaseVerification } = triageSpecFields(proposal.spec, ticketId);
      const authored = await authorSpecRowStructured(
        workspaceId,
        slug,
        {
          title: proposal.spec.title,
          summary: specSummary,
          owner: "cs",
          parent: `[[../functions/cs]] — Ticket-derived product fixes`,
          blocked_by: [],
          why: `Escalation-triage quorum on ticket ${ticketId} identified a product gap that requires a durable spec fix.`,
          what: `When this spec ships, the product gap the escalated ticket identified is resolved.`,
          phases: [
            {
              title: `P1 — implement the fix`,
              body: phaseBody,
              verification: phaseVerification,
              status: "planned",
              why: `Escalation-triage quorum on ticket ${ticketId} identified a product gap that requires a durable spec fix.`,
              what: `When this phase ships, the product gap the escalated ticket identified is resolved.`,
            },
          ],
        },
        "planned",
        { intendedStatusSetBy: "box:escalation-triage" },
      );
      if (authored) {
        out.specPath = slug;
        parts.push(`spec authored: ${slug} (owner=cs) — commission on Roadmap`);
      } else {
        parts.push(`spec author failed for ${slug}`);
      }
    } catch (e) {
      parts.push(`spec author failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  out.summary = parts.length ? parts.join("; ") : "nothing materialized (empty proposal)";
  return out;
}

// ── Audit (triage_runs) ──────────────────────────────────────────────────────

export async function recordTriageRun(
  admin: Admin,
  row: {
    id: string;
    workspaceId: string;
    jobId: string | null;
    ticketId: string;
    decision: TriageDecision | null;
    verdict: "agree" | "revise" | "reject" | "no_quorum";
    materialized: boolean;
    outcome: string;
    solverTranscript: unknown;
    skepticTranscript: unknown;
    groupId: string | null;
  },
): Promise<void> {
  await admin.from("triage_runs").insert({
    id: row.id,
    workspace_id: row.workspaceId,
    job_id: row.jobId,
    ticket_id: row.ticketId,
    decision: row.decision,
    verdict: row.verdict,
    materialized: row.materialized,
    outcome: row.outcome.slice(0, 4000),
    solver_transcript: row.solverTranscript ?? null,
    skeptic_transcript: row.skepticTranscript ?? null,
    group_id: row.groupId,
  });
}
