/**
 * approval-decisions — the tiny writer behind the `approval_decisions` table
 * ([[docs/brain/tables/approval_decisions.md]]), the supervisable-autonomy AUDIT LEDGER.
 *
 * Every decision a director (or the CEO) makes on a routed Approval Request writes ONE row here: an
 * autonomous auto-approval (decision='approved', decided_by='director', autonomous=true), a decline, or
 * an escalation UP to the CEO (decision='escalated'). That ledger is what makes the north-star contract
 * auditable — the CEO can read after the fact WHAT the proxy decided and WHY (CEO → Director → tool).
 * See [[docs/brain/goals/devops-director.md]] + [[docs/brain/specs/approval-routing-engine.md]].
 *
 * The FIRST concrete writer is the Platform/DevOps Director ([[docs/brain/specs/platform-director-agent.md]]).
 *
 * Best-effort + never throws: an audit write that crashed the decision it records would be worse than
 * the gap (mirrors [[director-activity]] / `enqueueRepairJob`). If the table isn't present yet (the
 * migration hasn't applied), this no-ops with a warning.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** Who actually made the call (open vocabulary — the DB has no CHECK). */
export type DecidedBy = "director" | "ceo" | "human";

/** The call itself (open vocabulary). `escalated` = punted UP to the CEO rather than acted on. */
export type ApprovalDecisionKind = "approved" | "declined" | "escalated";

export interface ApprovalDecisionInput {
  workspaceId: string;
  /** the gated agent_jobs row this decision acted on (the approval's source of truth). */
  agentJobId: string;
  /** the specific pending action decided, when a job carries more than one (null = the whole job). */
  pendingActionId?: string | null;
  /** the function that owns the raising tool (e.g. 'platform'); 'ceo' when the kind is unmapped. */
  raisedByFunction: string;
  /** where the approval was routed — the deciding role's function slug, or 'ceo'. */
  routedToFunction: string;
  decidedBy: DecidedBy | string;
  decision: ApprovalDecisionKind | string;
  /** the plain-text "why" — the reasoning the CEO audits after the fact. */
  reasoning: string;
  /** the decision was made by a live+autonomous director with no human in the loop. */
  autonomous: boolean;
  /** structured per-decision context: { kind?, spec_slug?, leash?, signature?, ... }. */
  metadata?: Record<string, unknown>;
}

/**
 * Insert one `approval_decisions` row. Best-effort + safe to call from any decision path. Returns
 * `{ recorded }` so a caller can log it, but NEVER throws.
 */
export async function recordApprovalDecision(admin: Admin, input: ApprovalDecisionInput): Promise<{ recorded: boolean; reason?: string }> {
  try {
    const { error } = await admin.from("approval_decisions").insert({
      workspace_id: input.workspaceId,
      agent_job_id: input.agentJobId,
      pending_action_id: input.pendingActionId ?? null,
      raised_by_function: input.raisedByFunction,
      routed_to_function: input.routedToFunction,
      decided_by: input.decidedBy,
      decision: input.decision,
      reasoning: (input.reasoning || "").slice(0, 4000),
      autonomous: input.autonomous,
      metadata: input.metadata ?? {},
    });
    if (error) {
      console.warn(`[approval-decisions] insert failed (${input.decision}):`, error.message);
      return { recorded: false, reason: error.message };
    }
    return { recorded: true };
  } catch (err) {
    console.warn("[approval-decisions] recordApprovalDecision threw:", err instanceof Error ? err.message : err);
    return { recorded: false, reason: "threw" };
  }
}
