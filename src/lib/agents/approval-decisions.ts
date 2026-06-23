/**
 * Approval-decision ledger (approval-routing-engine spec, Phase 3) — the supervisable-autonomy
 * audit log. One row per ROUTED decision in public.approval_decisions.
 *
 * North star (operational-rules § supervisable autonomy): an autonomous tool answers to an
 * objective-owner, never a silent proxy. When a future live+autonomous director auto-approves one
 * of its tools' requests, the CEO must always be able to audit WHAT the proxy decided and WHY — in
 * HISTORY, never in the queue. This module is the single chokepoint that records that.
 *
 * The invariant: NO auto-approval without a row here capturing the reasoning. Recording is
 * best-effort from the human approve path (it never breaks a decision) but is MANDATORY conceptually
 * for the autonomous path (the flag enables *who decides*, never *whether it's recorded*).
 *
 * `recordApprovalDecision` writes a row; `listApprovalDecisions` reads the Decision-history view
 * (CEO sees all; a director sees the decisions routed to it), with the same filters the UI exposes
 * (function · decision · autonomous-vs-human). See docs/brain/tables/approval_decisions.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { CEO } from "@/lib/agents/approval-router";

type Admin = ReturnType<typeof createAdminClient>;

export type DecidedBy = "ceo" | "director" | "human";
export type DecisionOutcome = "approved" | "declined" | "escalated";

/** One row of public.approval_decisions (the fields readers/writers use). */
export interface ApprovalDecisionRow {
  id: string;
  workspace_id: string;
  agent_job_id: string | null;
  pending_action_id: string | null;
  raised_by_function: string;
  routed_to_function: string;
  decided_by: DecidedBy;
  decision: DecisionOutcome;
  reasoning: string | null;
  autonomous: boolean;
  created_at: string;
}

/** The input to record one routed decision. */
export interface RecordDecisionInput {
  workspaceId: string;
  agentJobId?: string | null;
  pendingActionId?: string | null;
  raisedByFunction: string;
  routedToFunction: string;
  decidedBy: DecidedBy;
  decision: DecisionOutcome;
  reasoning?: string | null;
  /** true ONLY for an autonomous director auto-approval (decided_by='director'). */
  autonomous?: boolean;
}

/**
 * Insert one decision row. Best-effort: returns the row (or null on failure) and never throws into
 * the caller — recording the ledger must not break the decision it records. Forces `autonomous`
 * true only when a director decided (a ceo/human seat is never autonomous — fail-safe).
 */
export async function recordApprovalDecision(
  admin: Admin,
  input: RecordDecisionInput,
): Promise<ApprovalDecisionRow | null> {
  const autonomous = input.decidedBy === "director" ? input.autonomous === true : false;
  const row = {
    workspace_id: input.workspaceId,
    agent_job_id: input.agentJobId ?? null,
    pending_action_id: input.pendingActionId ?? null,
    raised_by_function: input.raisedByFunction || CEO,
    routed_to_function: input.routedToFunction || CEO,
    decided_by: input.decidedBy,
    decision: input.decision,
    reasoning: input.reasoning ?? null,
    autonomous,
  };
  const { data, error } = await admin.from("approval_decisions").insert(row).select("*").maybeSingle();
  if (error || !data) return null;
  return data as ApprovalDecisionRow;
}

/** Filters for the Decision-history view (each optional; absent ⇒ no constraint). */
export interface DecisionHistoryFilters {
  /** filter by the function the decision routed to (the auto-approver, or 'ceo'). */
  routedToFunction?: string;
  decision?: DecisionOutcome;
  /** true ⇒ autonomous-only; false ⇒ human/ceo-only; undefined ⇒ both. */
  autonomous?: boolean;
  limit?: number;
}

/**
 * Read the Decision history for a role. The CEO (role==='ceo') sees EVERY decision in the workspace
 * — the supervisable-autonomy guarantee that the CEO can always audit what any proxy decided. A
 * director role sees only the decisions routed to it. Newest-first; bounded.
 */
export async function listApprovalDecisions(
  admin: Admin,
  workspaceId: string,
  role: string,
  filters: DecisionHistoryFilters = {},
): Promise<ApprovalDecisionRow[]> {
  let q = admin
    .from("approval_decisions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(Math.min(filters.limit ?? 200, 500));

  // A director scopes to its own routed decisions; the CEO sees all (unless an explicit fn filter).
  if (role !== CEO) q = q.eq("routed_to_function", role);
  else if (filters.routedToFunction) q = q.eq("routed_to_function", filters.routedToFunction);

  if (filters.decision) q = q.eq("decision", filters.decision);
  if (typeof filters.autonomous === "boolean") q = q.eq("autonomous", filters.autonomous);

  const { data, error } = await q;
  if (error || !data) return [];
  return data as ApprovalDecisionRow[];
}
