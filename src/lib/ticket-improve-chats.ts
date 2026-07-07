/**
 * ticket-improve-chats — server helpers + shared types for the box-hosted Improve agent
 * (box-ticket-improve). The Improve tab is a ticket-bound, resumable session: one
 * public.ticket_improve_chats row per ticket, a turn spawns a kind='ticket-improve' agent_job
 * that resumes the box's Max `claude -p` session, and the box's proposed action plan is parked in
 * `pending_plan` until the founder/CX manager approves it.
 *
 * All writes go through createAdminClient() (service role). The plan is EXECUTED server-side by the
 * route (which holds prod creds) via the existing improve executors — the box never mutates.
 * See docs/brain/tables/ticket_improve_chats.md + docs/brain/specs/box-ticket-improve.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { ImproveAction } from "@/lib/improve-actions";
import type { SonnetDecision } from "@/lib/action-executor";

export type ChatMsg = { role: "user" | "assistant"; content: string };
export type TurnStatus = "idle" | "thinking" | "error" | "awaiting_approval";
export type SessionStatus = "active" | "resolved";

/** The kinds of action the box can propose in a plan. Each maps to a server-side executor on approval. */
export type ImprovePlanActionKind =
  | "customer_action" // any direct-action (refund/return/sub-change/coupon/message…) via runImproveActions
  | "orchestrator_action" // a full SonnetDecision driven through executeSonnetDecision — the EXACT production
  //   path the orchestrator uses (journey/playbook/workflow/macro/escalate + every direct action) with
  //   production-correct per-channel (portal/email/chat/sms) delivery. See improve-plan-executor.ts.
  | "sonnet_prompt" // propose a conversation-AI rule (sonnet_prompts, status='proposed')
  | "grader_rule" // propose a grader calibration rule (grader_prompts, status='proposed')
  | "rescore" // force re-analysis of THIS ticket (analyzeTicket)
  | "ticket_spec" // a code change → a ticket-sourced spec committed to main (owner=cs), surfaced on Roadmap
  | "resolve_sequence"; // the closeout: post internal note(s) → close → unassign → unescalate

/** One proposed action in a plan. Only the payload field matching `kind` is set. */
export interface ImprovePlanAction {
  id: string;
  kind: ImprovePlanActionKind;
  label: string; // one-line human summary for the approval card
  detail?: string; // optional longer explanation
  action?: ImproveAction; // customer_action: the direct-action {type, ...params}
  decision?: SonnetDecision; // orchestrator_action: the full {action_type, handler_name?, actions?, response_message?, reasoning}
  prompt?: { title: string; content: string; category?: string }; // sonnet_prompt
  rule?: { title: string; content: string }; // grader_rule
  /** ticket_spec — the payload the box's Improve agent hands back for a code-change spec.
   *  `mandate` (optional): improve-tab-spec-author-auto-anchors Phase 3 — the CS-function mandate the
   *  LLM picked at write time (a kebab slug on `docs/brain/functions/cs.md`; e.g.
   *  `ticket-derived-product-fixes`, `escalation-triage-quality`, or
   *  `fix-weird-tickets-fast-calibrate-so-they-don-t-recur`). Omitted / unknown ⇒ the executor lets the
   *  [[author-spec]] chokepoint's Phase 2 auto-anchor pick the best fit deterministically. */
  spec?: { slug: string; title: string; intent: string; problem: string; mandate?: string }; // ticket_spec
  resolve?: { internal_notes?: string[]; close?: boolean; unassign?: boolean; unescalate?: boolean }; // resolve_sequence
  status: "pending" | "approved" | "declined" | "done" | "failed";
  result?: string;
}

export interface ImprovePlan {
  summary: string;
  actions: ImprovePlanAction[];
}

export interface TicketImproveChat {
  id: string;
  workspace_id: string;
  user_id: string | null;
  ticket_id: string;
  box_session_id: string | null;
  messages: ChatMsg[];
  turn_status: TurnStatus;
  pending_plan: ImprovePlan | null;
  last_error: string | null;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
}

const ROW_COLUMNS =
  "id, workspace_id, user_id, ticket_id, box_session_id, messages, turn_status, pending_plan, last_error, status, created_at, updated_at";

function normalizeMessages(value: unknown): ChatMsg[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (m): m is ChatMsg =>
        !!m &&
        typeof m === "object" &&
        ((m as ChatMsg).role === "user" || (m as ChatMsg).role === "assistant") &&
        typeof (m as ChatMsg).content === "string",
    )
    .map((m) => ({ role: m.role, content: m.content }));
}

function toRow(row: Record<string, unknown> | null): TicketImproveChat | null {
  if (!row) return null;
  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    user_id: (row.user_id as string | null) ?? null,
    ticket_id: row.ticket_id as string,
    box_session_id: (row.box_session_id as string | null) ?? null,
    messages: normalizeMessages(row.messages),
    turn_status: (row.turn_status as TurnStatus) ?? "idle",
    pending_plan: (row.pending_plan as ImprovePlan | null) ?? null,
    last_error: (row.last_error as string | null) ?? null,
    status: (row.status as SessionStatus) ?? "active",
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/** Load the ticket's session, or create a fresh one (ticket-bound — one per ticket). */
export async function loadOrCreateSession(
  workspaceId: string,
  ticketId: string,
  userId: string,
): Promise<TicketImproveChat | null> {
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("ticket_improve_chats")
    .select(ROW_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("ticket_id", ticketId)
    .maybeSingle();
  if (existing) return toRow(existing as Record<string, unknown>);

  const { data: created } = await admin
    .from("ticket_improve_chats")
    .insert({ workspace_id: workspaceId, ticket_id: ticketId, user_id: userId })
    .select(ROW_COLUMNS)
    .single();
  return toRow(created as Record<string, unknown> | null);
}

/** Load the ticket's session (no create) — the GET/poll target. */
export async function loadSession(workspaceId: string, ticketId: string): Promise<TicketImproveChat | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("ticket_improve_chats")
    .select(ROW_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("ticket_id", ticketId)
    .maybeSingle();
  return toRow(data as Record<string, unknown> | null);
}

/** Patch a session by id (workspace-scoped) and return the fresh row. */
export async function patchSession(
  workspaceId: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<TicketImproveChat | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("ticket_improve_chats")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .select(ROW_COLUMNS)
    .maybeSingle();
  return toRow(data as Record<string, unknown> | null);
}
