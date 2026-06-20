/**
 * roadmap-chats — server helpers for the persisted authoring chat (public.roadmap_chats).
 *
 * The Roadmap authoring chat (AuthoringChat.tsx) keeps its transcript only in React state,
 * so closing the modal loses it. These helpers save/load the transcript to a DB row so a chat
 * is resumable cross-device. All writes go through createAdminClient() (service role).
 * See docs/brain/tables/roadmap_chats.md + docs/brain/specs/authoring-chat-persistence.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type ChatMsg = { role: "user" | "assistant"; content: string };
export type ChatStatus = "active" | "finalized";
// Per-turn lifecycle for the box-hosted spec chat (box-spec-chat): a turn enqueues a kind='spec-chat'
// job that runs on the box; the UI polls turn_status while it thinks. idle → thinking → idle (reply
// landed) or → error (box failed; UI offers a retry that re-resumes the same box session).
export type TurnStatus = "idle" | "thinking" | "error";

export type RoadmapChat = {
  id: string;
  workspace_id: string;
  user_id: string | null;
  spec_slug: string | null;
  title: string | null;
  messages: ChatMsg[];
  status: ChatStatus;
  // box-spec-chat: the resumable `claude -p` Max session id (null until turn 1 runs) + turn lifecycle.
  box_session_id: string | null;
  turn_status: TurnStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type SaveChatInput = {
  id?: string;
  workspaceId: string;
  userId: string;
  specSlug?: string | null;
  title?: string | null;
  messages: ChatMsg[];
  status?: ChatStatus;
};

const ROW_COLUMNS =
  "id, workspace_id, user_id, spec_slug, title, messages, status, box_session_id, turn_status, last_error, created_at, updated_at";

function normalizeMessages(value: unknown): ChatMsg[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((m): m is ChatMsg =>
      !!m && typeof m === "object" &&
      (((m as ChatMsg).role === "user") || ((m as ChatMsg).role === "assistant")) &&
      typeof (m as ChatMsg).content === "string")
    .map((m) => ({ role: m.role, content: m.content }));
}

function toRow(row: Record<string, unknown> | null): RoadmapChat | null {
  if (!row) return null;
  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    user_id: (row.user_id as string | null) ?? null,
    spec_slug: (row.spec_slug as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    messages: normalizeMessages(row.messages),
    status: (row.status as ChatStatus) ?? "active",
    box_session_id: (row.box_session_id as string | null) ?? null,
    turn_status: (row.turn_status as TurnStatus) ?? "idle",
    last_error: (row.last_error as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Upsert a chat session. Without an id a new row is inserted; with one the existing row is
 * updated (transcript autosave, status/slug on finalize). updated_at is bumped on every save.
 */
export async function saveChat(input: SaveChatInput): Promise<RoadmapChat | null> {
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const messages = normalizeMessages(input.messages);

  if (input.id) {
    const patch: Record<string, unknown> = { messages, updated_at: now };
    if (input.title !== undefined) patch.title = input.title;
    if (input.specSlug !== undefined) patch.spec_slug = input.specSlug;
    if (input.status !== undefined) patch.status = input.status;
    const { data } = await admin
      .from("roadmap_chats")
      .update(patch)
      .eq("id", input.id)
      .eq("workspace_id", input.workspaceId)
      .select(ROW_COLUMNS)
      .maybeSingle();
    return toRow(data as Record<string, unknown> | null);
  }

  const { data } = await admin
    .from("roadmap_chats")
    .insert({
      workspace_id: input.workspaceId,
      user_id: input.userId,
      spec_slug: input.specSlug ?? null,
      title: input.title ?? null,
      messages,
      status: input.status ?? "active",
      updated_at: now,
    })
    .select(ROW_COLUMNS)
    .single();
  return toRow(data as Record<string, unknown> | null);
}

/** Load one session by id, workspace-scoped. */
export async function loadChat(workspaceId: string, id: string): Promise<RoadmapChat | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("roadmap_chats")
    .select(ROW_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .maybeSingle();
  return toRow(data as Record<string, unknown> | null);
}

/** The latest still-active session for a spec slug (refine resume). */
export async function loadActiveChatForSlug(workspaceId: string, specSlug: string): Promise<RoadmapChat | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("roadmap_chats")
    .select(ROW_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", specSlug)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return toRow(data as Record<string, unknown> | null);
}

/**
 * box-spec-chat — append an optional user message and mark the thread "thinking" so the box can pick
 * up the turn. Clears any prior turn error. Returns the updated row (so the route can echo it back to
 * the UI). The box (runSpecChatJob) appends the assistant reply + flips turn_status back to 'idle'.
 */
export async function markTurnThinking(
  workspaceId: string,
  id: string,
  userMessage?: string,
): Promise<RoadmapChat | null> {
  const admin = createAdminClient();
  const existing = await loadChat(workspaceId, id);
  if (!existing) return null;
  const messages = userMessage
    ? [...existing.messages, { role: "user" as const, content: userMessage }]
    : existing.messages;
  const { data } = await admin
    .from("roadmap_chats")
    .update({ messages, turn_status: "thinking", last_error: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .select(ROW_COLUMNS)
    .maybeSingle();
  return toRow(data as Record<string, unknown> | null);
}

/** Recent active sessions for the resume list (one user's workspace, newest first). */
export async function listRecentChats(workspaceId: string, userId: string, limit = 20): Promise<RoadmapChat[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("roadmap_chats")
    .select(ROW_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(limit);
  return ((data as Record<string, unknown>[] | null) ?? []).map(toRow).filter((r): r is RoadmapChat => !!r);
}
