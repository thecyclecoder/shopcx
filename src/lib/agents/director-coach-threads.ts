/**
 * director-coach-threads — server helpers for the CEO↔Director coaching chat (director_coach_threads).
 * worker-grading-and-director-management Phase 7. Mirrors dev-message-threads.ts: each CEO turn enqueues
 * a kind='director-coach' agent_jobs row the box runs as a resumable `claude -p` Max session AS the
 * director (Ada) — read-only over the brain + her leash + roadmap + her activity — so she EXPLAINS her
 * own decisions ("why haven't you built spec X?"). The CEO then coaches her; a proposed `coaching` card
 * stops at an approval gate and, on approval, the worker writes a director_instruction (coachDirector)
 * that's injected into her future decisions. Owner-gated at the route/UI; all writes via service role.
 * See docs/brain/tables/director_coach_threads.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type ThreadMsg = { role: "user" | "assistant"; content: string };
export type TurnStatus = "idle" | "thinking" | "error";

// A gated approval card the box proposes (never executes itself):
//  - coaching: a durable director_instruction amendment — on approval the worker calls coachDirector, so
//    the learning is injected into her future decision prompts (this is the whole point of the chat).
//  - spec: an infra/automation capability-gap handoff — the worker commits docs/brain/specs/{slug}.md on
//    approval (+ optionally queues a build).
export type CoachThreadActionType = "coaching" | "spec" | "spec-edit" | "spec-status" | "goal" | "directive" | "model_tier";
export type CoachThreadActionStatus = "pending" | "approved" | "declined" | "done" | "failed";
export type CoachThreadAction = {
  id: string;
  type: CoachThreadActionType;
  summary: string;
  // coaching
  errorClass?: string;
  guidance?: string;
  triggeringPattern?: string;
  reasoning?: string;
  // spec handoff
  slug?: string;
  title?: string;
  owner?: string;
  parent?: string;
  content?: string;
  queueBuild?: boolean;
  // spec-status (ada-director-spec-status-cards) — the renamed status field on the card payload + flips:
  proposedStatus?: "planned" | "in_progress" | "shipped" | "rejected";
  phases?: { index: number; status: "planned" | "in_progress" | "shipped" | "rejected" }[];
  critical?: boolean;
  deferred?: boolean;
  reason?: string;
  status: CoachThreadActionStatus;
  result?: string;
  // ada-slack-chat: when this card was posted to #cto-ada, the Slack message ts — so a web-side OR
  // box-side decision can chat.update the card in place. Absent on web-only threads.
  slackTs?: string;
};

// ada-slack-chat: where a thread lives. 'web' (default) = the dashboard coach chat; 'slack' = a
// conversation in the #cto-ada channel, mirrored into the same web profile.
export type CoachThreadSource = "web" | "slack";

export type DirectorCoachThread = {
  id: string;
  workspace_id: string;
  user_id: string | null;
  director_function: string;
  title: string | null;
  messages: ThreadMsg[];
  box_session_id: string | null;
  turn_status: TurnStatus;
  last_error: string | null;
  pending_actions: CoachThreadAction[];
  source: CoachThreadSource;
  slack_channel_id: string | null;
  slack_thread_ts: string | null;
  created_at: string;
  updated_at: string;
};

const ROW_COLUMNS =
  "id, workspace_id, user_id, director_function, title, messages, box_session_id, turn_status, last_error, pending_actions, source, slack_channel_id, slack_thread_ts, created_at, updated_at";

function normalizeMessages(value: unknown): ThreadMsg[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((m): m is ThreadMsg => !!m && typeof m === "object" && (((m as ThreadMsg).role === "user") || ((m as ThreadMsg).role === "assistant")) && typeof (m as ThreadMsg).content === "string")
    .map((m) => ({ role: m.role, content: m.content }));
}

function normalizeActions(value: unknown): CoachThreadAction[] {
  if (!Array.isArray(value)) return [];
  return value.filter((a): a is CoachThreadAction => !!a && typeof a === "object" && typeof (a as CoachThreadAction).id === "string");
}

function toRow(row: Record<string, unknown> | null): DirectorCoachThread | null {
  if (!row) return null;
  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    user_id: (row.user_id as string | null) ?? null,
    director_function: (row.director_function as string) ?? "platform",
    title: (row.title as string | null) ?? null,
    messages: normalizeMessages(row.messages),
    box_session_id: (row.box_session_id as string | null) ?? null,
    turn_status: (row.turn_status as TurnStatus) ?? "idle",
    last_error: (row.last_error as string | null) ?? null,
    pending_actions: normalizeActions(row.pending_actions),
    source: (row.source as CoachThreadSource) ?? "web",
    slack_channel_id: (row.slack_channel_id as string | null) ?? null,
    slack_thread_ts: (row.slack_thread_ts as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Create a thread with an opening CEO message. `source`/`slack*` mark a #cto-ada conversation
 * (ada-slack-chat) so the box posts Ada's reply back to Slack; omit them for a web thread.
 */
export async function createThread(input: {
  workspaceId: string;
  userId: string;
  directorFunction?: string;
  message: string;
  source?: CoachThreadSource;
  slackChannelId?: string;
  slackThreadTs?: string;
}): Promise<DirectorCoachThread | null> {
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const { data } = await admin
    .from("director_coach_threads")
    .insert({
      workspace_id: input.workspaceId,
      user_id: input.userId,
      director_function: input.directorFunction ?? "platform",
      title: input.message.slice(0, 80),
      messages: [{ role: "user", content: input.message }],
      source: input.source ?? "web",
      slack_channel_id: input.slackChannelId ?? null,
      slack_thread_ts: input.slackThreadTs ?? null,
      updated_at: now,
    })
    .select(ROW_COLUMNS)
    .single();
  return toRow(data as Record<string, unknown> | null);
}

/**
 * Find a #cto-ada thread by its Slack thread root ts (ada-slack-chat) — used to continue the same
 * conversation when the founder replies inside one of Ada's threads. Null if no thread keys on it yet.
 */
export async function findThreadBySlackThreadTs(workspaceId: string, slackThreadTs: string): Promise<DirectorCoachThread | null> {
  if (!slackThreadTs) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("director_coach_threads")
    .select(ROW_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("slack_thread_ts", slackThreadTs)
    .maybeSingle();
  return toRow(data as Record<string, unknown> | null);
}

/** Load one thread by id, workspace-scoped. */
export async function loadThread(workspaceId: string, id: string): Promise<DirectorCoachThread | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("director_coach_threads").select(ROW_COLUMNS).eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
  return toRow(data as Record<string, unknown> | null);
}

/** Append an optional CEO message + mark "thinking" so the box picks up the turn. Clears prior error. */
export async function markThreadThinking(workspaceId: string, id: string, userMessage?: string): Promise<DirectorCoachThread | null> {
  const admin = createAdminClient();
  const existing = await loadThread(workspaceId, id);
  if (!existing) return null;
  const messages = userMessage ? [...existing.messages, { role: "user" as const, content: userMessage }] : existing.messages;
  const { data } = await admin
    .from("director_coach_threads")
    .update({ messages, turn_status: "thinking", last_error: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .select(ROW_COLUMNS)
    .maybeSingle();
  return toRow(data as Record<string, unknown> | null);
}

/** Record the CEO's decision on one coaching/spec card (approve/decline). The worker executes it. */
export async function setActionDecision(workspaceId: string, id: string, actionId: string, decision: "approve" | "decline"): Promise<DirectorCoachThread | null> {
  const admin = createAdminClient();
  const existing = await loadThread(workspaceId, id);
  if (!existing) return null;
  const pending_actions = existing.pending_actions.map((a) =>
    a.id === actionId && a.status === "pending" ? { ...a, status: decision === "approve" ? ("approved" as const) : ("declined" as const) } : a,
  );
  const patch: Record<string, unknown> = { pending_actions, updated_at: new Date().toISOString() };
  if (decision === "approve") patch.turn_status = "thinking";
  const { data } = await admin.from("director_coach_threads").update(patch).eq("id", id).eq("workspace_id", workspaceId).select(ROW_COLUMNS).maybeSingle();
  return toRow(data as Record<string, unknown> | null);
}

/** Recent threads for the resume list (one user's workspace, newest first). */
export async function listRecentThreads(workspaceId: string, userId: string, limit = 20): Promise<DirectorCoachThread[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("director_coach_threads")
    .select(ROW_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  return ((data as Record<string, unknown>[] | null) ?? []).map(toRow).filter((r): r is DirectorCoachThread => !!r);
}
