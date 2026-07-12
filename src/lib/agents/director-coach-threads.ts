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
import { randomBytes } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { SLIDING_TTL_MS, ABSOLUTE_TTL_MS, cockpitUrl, sendGodModeSMS } from "@/lib/god-mode";
import { PERSONAS } from "@/lib/agents/personas";

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
  // director-sms-cockpit-per-director Phase 3: the M3 escalation path stamps this
  // TRUE on a card that hit the director's leash rail (out-of-leash, destructive,
  // or new-goal — anything routed through `escalateApprovalRequestToCeo`). The
  // SMS-cockpit approve route PIN-gates on this flag; in-leash cards (rail
  // absent or FALSE) never prompt for a PIN.
  rail?: boolean;
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
  // ada-slack-routed-approvals Phase 3: a chat-mode invitation thread carries the routed
  // approval's context here ({chat_mode:true, agent_job_id, notification_id, spec_slug, kind,
  // investigation}) so the box turn knows which approval the founder is discussing without the
  // model having to re-derive it. Empty {} on a normal web/Slack ask thread.
  metadata: Record<string, unknown>;
  // director-sms-cockpit-per-director Phase 1: the 48-hex SMS-cockpit token minted by
  // armDirectorCockpit + its sliding/absolute TTLs mirroring god_mode_sessions. Null on
  // a thread that has never been armed for SMS-cockpit access. sms_notified_at gets
  // stamped by the pending-approval nudge sweep so we never re-nudge the same wait.
  cockpit_token: string | null;
  token_expires_at: string | null;
  absolute_expires_at: string | null;
  sms_notified_at: string | null;
  created_at: string;
  updated_at: string;
};

const ROW_COLUMNS =
  "id, workspace_id, user_id, director_function, title, messages, box_session_id, turn_status, last_error, pending_actions, source, slack_channel_id, slack_thread_ts, metadata, cockpit_token, token_expires_at, absolute_expires_at, sms_notified_at, created_at, updated_at";

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
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    cockpit_token: (row.cockpit_token as string | null) ?? null,
    token_expires_at: (row.token_expires_at as string | null) ?? null,
    absolute_expires_at: (row.absolute_expires_at as string | null) ?? null,
    sms_notified_at: (row.sms_notified_at as string | null) ?? null,
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

/**
 * Create a #cto-ada chat-mode invitation thread for a routed CEO approval
 * ([[../specs/ada-slack-routed-approvals]] Phase 3). Differs from `createThread` in two ways:
 *   - the opening message is Ada's invitation (assistant), not the founder (user) — when the founder
 *     replies in the Slack thread the events handler appends a user turn and the box resumes;
 *   - `metadata` is pre-seeded with the approval's context (chat_mode flag, agent_job_id,
 *     notification_id, spec_slug, kind, investigation preview) so the box turn knows which routed
 *     approval the conversation is about without re-deriving it.
 */
export async function createChatModeInvitationThread(input: {
  workspaceId: string;
  userId: string;
  directorFunction?: string;
  invitation: string;
  slackChannelId: string;
  slackThreadTs: string;
  metadata: Record<string, unknown>;
}): Promise<DirectorCoachThread | null> {
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const { data } = await admin
    .from("director_coach_threads")
    .insert({
      workspace_id: input.workspaceId,
      user_id: input.userId,
      director_function: input.directorFunction ?? "platform",
      title: input.invitation.slice(0, 80),
      messages: [{ role: "assistant", content: input.invitation }],
      source: "slack",
      slack_channel_id: input.slackChannelId,
      slack_thread_ts: input.slackThreadTs,
      metadata: input.metadata,
      updated_at: now,
    })
    .select(ROW_COLUMNS)
    .single();
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

// ── director-sms-cockpit-per-director Phase 1 — arm / disarm / resolve ────────────────────────────
//
// The SMS cockpit primitives for a director thread. They deliberately mirror god-mode.ts's
// armSession / disarmSession / resolveCockpitToken so the /god/[token] surface can route a
// director token through the SAME 48-hex + sliding/absolute TTL discipline as Eve's cockpit,
// but resolve against a director_coach_threads row (never god_mode_sessions).
//
// The TWO cockpit token spaces are DISJOINT — src/lib/cockpit-resolver.ts is the single
// chokepoint that decides director vs god. A token found in director_coach_threads maps to
// { kind:'director', thread }; a token found in god_mode_sessions maps to { kind:'god', session }.

/** 48-char hex cockpit token (24 random bytes) — same size as god_mode_sessions.cockpit_token. */
function newDirectorCockpitToken(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Arm a director thread for SMS-cockpit access. Mints a fresh 48-hex cockpit_token,
 * sets sliding + absolute TTLs from god-mode's constants, and returns the row + the
 * cockpit URL the SMS body carries. Idempotent per thread — re-arming an already-armed
 * thread REFRESHES the token (new slug + reset TTLs), mirroring armSession's discipline.
 * Clears sms_notified_at so a fresh arm never inherits a stale nudge stamp.
 */
export async function armDirectorCockpit(input: {
  workspaceId: string;
  threadId: string;
}): Promise<{ thread: DirectorCoachThread; cockpitToken: string; cockpitUrl: string } | null> {
  const admin = createAdminClient();
  const now = new Date();
  const token = newDirectorCockpitToken();
  const tokenExpiresAt = new Date(now.getTime() + SLIDING_TTL_MS).toISOString();
  const absoluteExpiresAt = new Date(now.getTime() + ABSOLUTE_TTL_MS).toISOString();

  const { data } = await admin
    .from("director_coach_threads")
    .update({
      cockpit_token: token,
      token_expires_at: tokenExpiresAt,
      absolute_expires_at: absoluteExpiresAt,
      sms_notified_at: null,
      updated_at: now.toISOString(),
    })
    .eq("id", input.threadId)
    .eq("workspace_id", input.workspaceId)
    .select(ROW_COLUMNS)
    .maybeSingle();
  const thread = toRow(data as Record<string, unknown> | null);
  if (!thread) return null;

  // director-sms-cockpit-per-director Phase 3: fire the arm SMS through the
  // SAME sendGodModeSMS primitive Eve's cockpit uses — persona-named copy, no
  // Eve flirt. Best-effort (matches sendGodModeSMS's discipline); a Twilio
  // failure here never blocks the arm write.
  const personaName = (PERSONAS[thread.director_function] as { name?: string } | undefined)?.name ?? "the director";
  void sendGodModeSMS(admin, {
    workspaceId: input.workspaceId,
    kind: "director-arm",
    cockpitToken: token,
    context: { personaName },
  });

  return { thread, cockpitToken: token, cockpitUrl: cockpitUrl(token) };
}

/**
 * Disarm a director thread — nulls the cockpit_token + TTL columns so the /god/[token]
 * surface stops resolving it. Idempotent: a thread with no active cockpit is a no-op.
 * Returns the post-disarm row (or null on unknown/cross-workspace).
 */
export async function disarmDirectorCockpit(input: {
  workspaceId: string;
  threadId: string;
}): Promise<DirectorCoachThread | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("director_coach_threads")
    .update({
      cockpit_token: null,
      token_expires_at: null,
      absolute_expires_at: null,
      sms_notified_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.threadId)
    .eq("workspace_id", input.workspaceId)
    .select(ROW_COLUMNS)
    .maybeSingle();
  return toRow(data as Record<string, unknown> | null);
}

/**
 * Resolve a 48-hex cockpit token to a director_coach_threads row (or null on unknown /
 * wrong-length / expired). Mirrors god-mode's resolveCockpitToken discipline: a row past
 * token_expires_at OR absolute_expires_at resolves to null — the caller (cockpit-resolver
 * chokepoint) never returns an expired thread. Wrong-length tokens short-circuit BEFORE
 * hitting the DB.
 */
export async function resolveDirectorCockpitToken(token: string): Promise<DirectorCoachThread | null> {
  if (!token || token.length !== 48) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("director_coach_threads")
    .select(ROW_COLUMNS)
    .eq("cockpit_token", token)
    .maybeSingle();
  const thread = toRow(data as Record<string, unknown> | null);
  if (!thread) return null;
  const now = new Date();
  if (thread.absolute_expires_at && new Date(thread.absolute_expires_at) < now) return null;
  if (thread.token_expires_at && new Date(thread.token_expires_at) < now) return null;
  return thread;
}
