/**
 * dev-message-threads — server helpers for the Developer > Message Center (public.dev_message_threads).
 *
 * A founder-facing, read-only "ask the box anything" console: each user turn enqueues a kind='dev-ask'
 * agent_jobs row that the build box runs as a long-running, resumable `claude -p` session on Max (whole
 * brain + full repo + read-only prod DB + WebSearch). The thread itself is the dev_message_threads row.
 * Reads are silent; every proposed DB write / migration / spec handoff stops at an approval card in
 * pending_actions that only the owner's click executes (the worker runs it, never the model).
 * All writes go through createAdminClient() (service role). Owner-gated at the route/UI.
 * See docs/brain/tables/dev_message_threads.md + docs/brain/specs/developer-message-center.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type ThreadMsg = { role: "user" | "assistant"; content: string };
// Per-turn lifecycle (mirrors the box-spec-chat shape): a turn enqueues a kind='dev-ask' job; the UI
// polls turn_status while the box thinks. idle → thinking → idle (reply landed) or → error (box failed).
export type TurnStatus = "idle" | "thinking" | "error";

// A gated approval card. Reads need none; only a proposed mutation/migration/spec handoff produces one.
//  - db_mutation: `cmd` is a self-contained shell command the WORKER runs on approval (a fresh worktree
//    with prod creds), `preview` is the human-readable change. The model never runs the write itself.
//  - spec: a code/capability-gap handoff — `content` is the full docs/brain/specs/{slug}.md the worker
//    commits to main on approval (+ optionally queues a kind='build' job when queueBuild).
export type DevThreadActionType = "db_mutation" | "spec";
export type DevThreadActionStatus = "pending" | "approved" | "declined" | "done" | "failed";
export type DevThreadAction = {
  id: string;
  type: DevThreadActionType;
  summary: string;
  // db_mutation
  cmd?: string;
  preview?: string;
  // spec handoff
  slug?: string;
  title?: string;
  owner?: string;
  parent?: string;
  content?: string;
  queueBuild?: boolean;
  status: DevThreadActionStatus;
  result?: string;
};

export type DevMessageThread = {
  id: string;
  workspace_id: string;
  user_id: string | null;
  title: string | null;
  messages: ThreadMsg[];
  box_session_id: string | null;
  turn_status: TurnStatus;
  last_error: string | null;
  pending_actions: DevThreadAction[];
  created_at: string;
  updated_at: string;
};

const ROW_COLUMNS =
  "id, workspace_id, user_id, title, messages, box_session_id, turn_status, last_error, pending_actions, created_at, updated_at";

function normalizeMessages(value: unknown): ThreadMsg[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((m): m is ThreadMsg =>
      !!m && typeof m === "object" &&
      (((m as ThreadMsg).role === "user") || ((m as ThreadMsg).role === "assistant")) &&
      typeof (m as ThreadMsg).content === "string")
    .map((m) => ({ role: m.role, content: m.content }));
}

function normalizeActions(value: unknown): DevThreadAction[] {
  if (!Array.isArray(value)) return [];
  return value.filter((a): a is DevThreadAction => !!a && typeof a === "object" && typeof (a as DevThreadAction).id === "string");
}

function toRow(row: Record<string, unknown> | null): DevMessageThread | null {
  if (!row) return null;
  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    user_id: (row.user_id as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    messages: normalizeMessages(row.messages),
    box_session_id: (row.box_session_id as string | null) ?? null,
    turn_status: (row.turn_status as TurnStatus) ?? "idle",
    last_error: (row.last_error as string | null) ?? null,
    pending_actions: normalizeActions(row.pending_actions),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/** Create a thread with an opening user message (the first turn of a brand-new thread). */
export async function createThread(input: {
  workspaceId: string;
  userId: string;
  title?: string | null;
  message: string;
}): Promise<DevMessageThread | null> {
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const { data } = await admin
    .from("dev_message_threads")
    .insert({
      workspace_id: input.workspaceId,
      user_id: input.userId,
      title: input.title ?? input.message.slice(0, 80),
      messages: [{ role: "user", content: input.message }],
      updated_at: now,
    })
    .select(ROW_COLUMNS)
    .single();
  return toRow(data as Record<string, unknown> | null);
}

/** Load one thread by id, workspace-scoped. */
export async function loadThread(workspaceId: string, id: string): Promise<DevMessageThread | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("dev_message_threads")
    .select(ROW_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .maybeSingle();
  return toRow(data as Record<string, unknown> | null);
}

/**
 * Append an optional user message and mark the thread "thinking" so the box can pick up the turn.
 * Clears any prior turn error. Returns the updated row (so the route can echo it back to the UI).
 */
export async function markThreadThinking(
  workspaceId: string,
  id: string,
  userMessage?: string,
): Promise<DevMessageThread | null> {
  const admin = createAdminClient();
  const existing = await loadThread(workspaceId, id);
  if (!existing) return null;
  const messages = userMessage
    ? [...existing.messages, { role: "user" as const, content: userMessage }]
    : existing.messages;
  const { data } = await admin
    .from("dev_message_threads")
    .update({ messages, turn_status: "thinking", last_error: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .select(ROW_COLUMNS)
    .maybeSingle();
  return toRow(data as Record<string, unknown> | null);
}

/**
 * Record the owner's decision on one pending approval card (approve/dismiss), workspace-scoped. The
 * worker (runDeveloperMessageJob, mode:'approve_action') is what actually executes an approved card.
 */
export async function setActionDecision(
  workspaceId: string,
  id: string,
  actionId: string,
  decision: "approve" | "decline",
): Promise<DevMessageThread | null> {
  const admin = createAdminClient();
  const existing = await loadThread(workspaceId, id);
  if (!existing) return null;
  const pending_actions = existing.pending_actions.map((a) =>
    a.id === actionId && a.status === "pending"
      ? { ...a, status: decision === "approve" ? ("approved" as const) : ("declined" as const) }
      : a,
  );
  const patch: Record<string, unknown> = { pending_actions, updated_at: new Date().toISOString() };
  // Approving (re)launches a box turn that executes it; declining is terminal (no box turn).
  if (decision === "approve") patch.turn_status = "thinking";
  const { data } = await admin
    .from("dev_message_threads")
    .update(patch)
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .select(ROW_COLUMNS)
    .maybeSingle();
  return toRow(data as Record<string, unknown> | null);
}

/** Recent threads for the resume list (one user's workspace, newest first). */
export async function listRecentThreads(workspaceId: string, userId: string, limit = 20): Promise<DevMessageThread[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("dev_message_threads")
    .select(ROW_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  return ((data as Record<string, unknown>[] | null) ?? []).map(toRow).filter((r): r is DevMessageThread => !!r);
}
