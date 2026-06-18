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

export type RoadmapChat = {
  id: string;
  workspace_id: string;
  user_id: string | null;
  spec_slug: string | null;
  title: string | null;
  messages: ChatMsg[];
  status: ChatStatus;
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

const ROW_COLUMNS = "id, workspace_id, user_id, spec_slug, title, messages, status, created_at, updated_at";

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
