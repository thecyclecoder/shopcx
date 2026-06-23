/**
 * Director board — server-side reads + the post helper (directors-board-gamified spec, Phase 1).
 *
 * The admin-client layer behind the Slack-style #directors channel ([[board.ts]] holds the client-safe
 * types). `getDirectorBoard` reads a workspace's [[director_messages]] rows newest-first; `postDirectorMessage`
 * is the ONE write path every author goes through — the system seed now, the live Platform director (M4),
 * the CEO reply (Phase 2), the EOD recap cron (Phase 4). All writes go through createAdminClient() (service
 * role) per the CLAUDE.md invariant. See docs/brain/tables/director_messages.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { BoardAuthor, BoardMessage, BoardMessageKind } from "@/lib/agents/board";

const BOARD_READ_LIMIT = 300;

interface DirectorMessageRow {
  id: string;
  author: string;
  author_function: string | null;
  body: string;
  kind: string;
  parent_message_id: string | null;
  mentions: string[] | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

function toBoardMessage(r: DirectorMessageRow): BoardMessage {
  return {
    id: r.id,
    author: r.author as BoardAuthor,
    authorFunction: r.author_function,
    body: r.body,
    kind: r.kind as BoardMessageKind,
    parentMessageId: r.parent_message_id,
    mentions: r.mentions ?? [],
    metadata: r.metadata ?? {},
    createdAt: r.created_at,
  };
}

/** A workspace's #directors channel — flat rows newest-first (the API threads them via threadMessages). */
export async function getDirectorBoard(workspaceId: string): Promise<BoardMessage[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("director_messages")
    .select("id, author, author_function, body, kind, parent_message_id, mentions, metadata, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(BOARD_READ_LIMIT);
  if (error) throw error;
  return (data ?? []).map((r) => toBoardMessage(r as DirectorMessageRow));
}

export interface PostDirectorMessageInput {
  workspaceId: string;
  author: BoardAuthor;
  /** the function slug for a director post (omit for ceo/system). */
  authorFunction?: string | null;
  body: string;
  kind: BoardMessageKind;
  /** the post this reply answers (threads it). */
  parentMessageId?: string | null;
  mentions?: string[];
  metadata?: Record<string, unknown>;
}

/** The single write path onto the board — every author (seed · M4 director · CEO reply · EOD recap) goes through here. */
export async function postDirectorMessage(input: PostDirectorMessageInput): Promise<BoardMessage> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("director_messages")
    .insert({
      workspace_id: input.workspaceId,
      author: input.author,
      author_function: input.authorFunction ?? null,
      body: input.body,
      kind: input.kind,
      parent_message_id: input.parentMessageId ?? null,
      mentions: input.mentions ?? [],
      metadata: input.metadata ?? {},
    })
    .select("id, author, author_function, body, kind, parent_message_id, mentions, metadata, created_at")
    .single();
  if (error) throw error;
  return toBoardMessage(data as DirectorMessageRow);
}
