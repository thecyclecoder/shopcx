/**
 * Agent To-Do system — the agent_todos row shape + per-action payload shapes.
 * See docs/brain/tables/agent_todos.md.
 */
import type {
  AgentTodoActionType,
  AgentTodoStatus,
  AgentTodoUrgency,
  AgentTodoSource,
} from "./constants";

export interface AgentTodo {
  id: string;
  workspace_id: string;
  source: AgentTodoSource;
  source_ticket_id: string | null;
  group_id: string;
  action_type: AgentTodoActionType;
  payload: AgentTodoPayload;
  summary: string;
  context_what_happened: string | null;
  context_what_we_propose: string | null;
  pre_exec_context: PreExecContext;
  confidence: number | null;
  urgency: AgentTodoUrgency;
  status: AgentTodoStatus;
  approved_by: string | null;
  approved_at: string | null;
  approval_role: "owner" | "admin" | null;
  executed_at: string | null;
  execution_result: ExecutionResult | null;
  rejected_at: string | null;
  rejected_by: string | null;
  reject_reason: string | null;
  routine_run_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Snapshot captured at proposal time for drift detection. */
export interface PreExecContext {
  latest_inbound_message_id?: string | null;
  latest_message_id?: string | null;
  sub_state_hash?: string | null;
  ticket_status?: string | null;
  [k: string]: unknown;
}

export interface ExecutionResult {
  ok?: boolean;
  error?: string;
  // DB-action results:
  row_id?: string;
  // PR-action results:
  pr_url?: string;
  branch?: string;
  merged_at?: string;
  // message-send results:
  message_id?: string;
  [k: string]: unknown;
}

// ── Per-action payloads ────────────────────────────────────────────────────

export interface CustomerReplyPayload {
  body_html: string; // exact HTML the customer will see (plain text, no markdown)
  to_email?: string | null;
  subject?: string | null;
  in_reply_to?: string | null;
}

export type CustomerActionKind =
  | "sub_remove_item"
  | "sub_pause"
  | "refund"
  | "return_label"
  | "store_credit"
  | "loyalty_apply";

export interface CustomerActionPayload {
  kind: CustomerActionKind;
  params: Record<string, unknown>;
  /** Human-readable diff line for the detail-page preview. */
  diff_summary?: string;
}

export interface SonnetPromptPayload {
  title: string;
  category: "rule" | "approach" | "tool_hint" | "personality" | "knowledge";
  content: string;
  /** For sonnet_prompt_edit: the existing row to edit. */
  target_prompt_id?: string;
}

export interface TicketAnalysisRescorePayload {
  ticket_analysis_id: string;
  score: number;
  summary: string;
  issues: Array<{ type: string; description: string }>;
}

export interface DiffPayload {
  /** Unified diff (git apply-able) OR a description the routine applies. */
  unified_diff?: string;
  file_path?: string;
  /** For brain edits the routine can also accept a full new file body. */
  new_file_body?: string;
  /** brain_doc_edit only: when true, auto-merge after CI (never for code). */
  auto_merge?: boolean;
  rationale?: string;
}

export type AgentTodoPayload =
  | CustomerReplyPayload
  | CustomerActionPayload
  | SonnetPromptPayload
  | TicketAnalysisRescorePayload
  | DiffPayload
  | Record<string, unknown>;
