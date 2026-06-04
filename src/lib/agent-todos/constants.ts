/**
 * Agent To-Do system — shared constants, action-type taxonomy, and the
 * role-gated approval matrix.
 *
 * See docs/brain/specs/agent-todo-system.md and
 * docs/brain/lifecycles/agent-todo-system.md.
 */
import type { WorkspaceRole } from "@/lib/types/workspace";

export type AgentTodoActionType =
  | "customer_reply"
  | "customer_action"
  | "ticket_close"
  | "sonnet_prompt_new"
  | "sonnet_prompt_edit"
  | "ticket_analysis_rescore"
  | "grader_prompt_edit"
  | "escalation_rule_fix"
  | "brain_doc_edit"
  | "code_change";

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
  "sonnet_prompt_new",
  "sonnet_prompt_edit",
  "ticket_analysis_rescore",
  "grader_prompt_edit",
  "escalation_rule_fix",
  "brain_doc_edit",
  "code_change",
];

/** Action types the Inngest event worker executes within seconds of approval. */
export const CUSTOMER_FACING_ACTION_TYPES: AgentTodoActionType[] = [
  "customer_reply",
  "customer_action",
  "ticket_close",
];

/** Action types the Claude Code Routine executes (DB inserts, brain/code PRs). */
export const SYSTEM_LEVEL_ACTION_TYPES: AgentTodoActionType[] = [
  "sonnet_prompt_new",
  "sonnet_prompt_edit",
  "ticket_analysis_rescore",
  "grader_prompt_edit",
  "escalation_rule_fix",
  "brain_doc_edit",
  "code_change",
];

/** Action types whose execution opens a PR on a claude/-prefixed branch. */
export const PR_ACTION_TYPES: AgentTodoActionType[] = [
  "brain_doc_edit",
  "code_change",
  // grader_prompt_edit / escalation_rule_fix land as code → PR path when
  // the proposed change touches code rather than a DB row.
  "grader_prompt_edit",
  "escalation_rule_fix",
];

export function isCustomerFacing(t: AgentTodoActionType): boolean {
  return CUSTOMER_FACING_ACTION_TYPES.includes(t);
}

export function isSystemLevel(t: AgentTodoActionType): boolean {
  return SYSTEM_LEVEL_ACTION_TYPES.includes(t);
}

/**
 * Role-gated approval matrix (spec § Safety / invariants).
 *
 *  | action_type                                  | Approver        |
 *  | customer_reply/action/close                  | owner OR admin  |
 *  | ticket_analysis_rescore                      | owner OR admin  |
 *  | sonnet_prompt_new/edit                        | owner only      |
 *  | grader_prompt_edit, escalation_rule_fix      | owner only      |
 *  | brain_doc_edit, code_change                   | owner only      |
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
