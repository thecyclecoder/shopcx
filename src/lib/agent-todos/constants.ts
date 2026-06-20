/**
 * Agent To-Do system — shared constants, action-type taxonomy, and the
 * role-gated approval matrix.
 *
 * See docs/brain/specs/agent-todo-system.md and
 * docs/brain/lifecycles/agent-todo-system.md.
 */
import type { WorkspaceRole } from "@/lib/types/workspace";

// Post-prune (box-escalation-triage P4): the box only ever produces these four. The retired
// Anthropic-cloud routine's system-level outputs (sonnet_prompt_*, grader_prompt_edit,
// escalation_rule_fix, brain_doc_edit, code_change) are now `proposed` sonnet_prompts or committed
// spec files — never agent_todos. The DB CHECK enforces the same set (NOT VALID, so historical rows
// carrying a retired type survive as the audit trail).
export type AgentTodoActionType =
  | "customer_reply"
  | "customer_action"
  | "ticket_close"
  | "ticket_analysis_rescore";

export type AgentTodoStatus =
  | "pending"
  | "approved"
  | "executed"
  | "rejected"
  | "superseded"
  | "failed";

export type AgentTodoUrgency = "urgent" | "normal" | "low";
export type AgentTodoSource = "ticket" | "csat" | "cron" | "manual";

export const ALL_ACTION_TYPES: AgentTodoActionType[] = [
  "customer_reply",
  "customer_action",
  "ticket_close",
  "ticket_analysis_rescore",
];

/** Action types that touch the customer (reply/account change/close). */
export const CUSTOMER_FACING_ACTION_TYPES: AgentTodoActionType[] = [
  "customer_reply",
  "customer_action",
  "ticket_close",
];

export function isCustomerFacing(t: AgentTodoActionType): boolean {
  return CUSTOMER_FACING_ACTION_TYPES.includes(t);
}

/**
 * Action types the Inngest event worker (`agent-todo-execute`) runs within seconds of approval.
 * After the Anthropic-cloud routine was retired (box-escalation-triage), ticket_analysis_rescore —
 * the one non-customer survivor — executes here too (a single ticket_analyses update), so EVERY
 * remaining action type is Inngest-executable. The box never executes todos itself; it only proposes.
 */
export function isInngestExecutable(t: AgentTodoActionType): boolean {
  return isCustomerFacing(t) || t === "ticket_analysis_rescore";
}

/**
 * Role-gated approval matrix. Post-prune (box-escalation-triage) every surviving agent_todo type is
 * owner-OR-admin approvable — they are all customer fixes or a re-score. (Rule/prompt proposals now
 * live in sonnet_prompts, where `admin`/Zach approves them; code/analyzer fixes are spec files
 * commissioned on Roadmap — neither is an agent_todo anymore.)
 *
 *  | action_type                  | Approver        |
 *  | customer_reply/action/close  | owner OR admin  |
 *  | ticket_analysis_rescore      | owner OR admin  |
 */
const OWNER_OR_ADMIN: AgentTodoActionType[] = [
  "customer_reply",
  "customer_action",
  "ticket_close",
  "ticket_analysis_rescore",
];

export function canApprove(role: WorkspaceRole, action: AgentTodoActionType): boolean {
  if (role === "owner") return true; // owner approves everything
  if (role === "admin") return OWNER_OR_ADMIN.includes(action);
  return false; // agent / social / marketing / read_only: visibility only
}

/** Roles that can ever approve any todo (used for the role gate on the API). */
export function isApproverRole(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin";
}

/** The label shown in place of approve/reject when the viewer can't approve. */
export const NEEDS_OWNER_LABEL = "Needs owner access to approve";
