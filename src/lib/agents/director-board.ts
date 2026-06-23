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
import type { BoardAuthor, BoardMessage, BoardMessageKind, BoardReplyLink, BoardThreadKind } from "@/lib/agents/board";
import { getPersona } from "@/lib/agents/personas";
import { createThread, markThreadThinking } from "@/lib/dev-message-threads";
import { saveChat, markTurnThinking } from "@/lib/roadmap-chats";

const BOARD_READ_LIMIT = 300;
const isSlug = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9-]+$/i.test(s);

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

/** Load one board post (or reply) by id, workspace-scoped — used to resolve the parent of a CEO reply. */
export async function getBoardPost(workspaceId: string, id: string): Promise<BoardMessage | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("director_messages")
    .select("id, author, author_function, body, kind, parent_message_id, mentions, metadata, created_at")
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .maybeSingle();
  return data ? toBoardMessage(data as DirectorMessageRow) : null;
}

// ── Phase 2: two-way reply routed to the existing answer brains ──────────────────────────────────────
//
// The CEO replies / asks "why?" under a director's post → we DON'T stand up a new LLM path. We reuse the
// box answer-brain sessions: a question about a specific spec routes to spec-chat ([[roadmap-chats]]); any
// other read-only "why/how/is it working" routes to dev-ask ([[dev-message-threads]]). We create the brain
// thread (seeded with the board context), flip it to thinking, and enqueue the box turn — stamping a
// BoardReplyLink into the job so the worker posts the director's answer straight back here as a `reply`.
// The CEO's own message is stored as a `reply` carrying the thread linkage so the GET can surface "thinking".

/** Frame the CEO's board question as the opening message of the answer-brain thread (the box answers in persona). */
function boardQuestionPrompt(p: {
  directorName: string;
  role: string;
  postBody: string;
  question: string;
  specSlug?: string;
}): string {
  return [
    `You are ${p.directorName}, the ${p.role} director, answering the CEO on the internal #directors board (a team channel).`,
    p.specSlug ? `This question is about the spec "${p.specSlug}".` : ``,
    `Your board post the CEO is replying to:`,
    `"${p.postBody}"`,
    ``,
    `The CEO's reply / question:`,
    `"${p.question}"`,
    ``,
    `Investigate read-only (the brain + code + read-only prod DB) and answer the CEO conversationally, in the first person as ${p.directorName} — plain text, 1-3 short sentences, grounded in what you actually found. No markdown. Your answer posts straight back to the board as your threaded reply, so write it as a chat message to the CEO.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface RouteBoardReplyResult {
  ceoMessage: BoardMessage;
  threadKind: BoardThreadKind;
  threadId: string;
}

/**
 * Post a CEO reply onto the board and route it to the right answer brain (dev-ask | spec-chat). Returns the
 * stored CEO `reply` (with the thread linkage in its metadata) or `{ error }`. The director's answer is posted
 * back asynchronously by the worker once the box turn finishes (see scripts/builder-worker.ts → postBoardAnswer).
 */
export async function routeBoardReply(input: {
  workspaceId: string;
  userId: string;
  parentMessageId: string;
  body: string;
  mentions?: string[];
}): Promise<RouteBoardReplyResult | { error: string }> {
  const parent = await getBoardPost(input.workspaceId, input.parentMessageId);
  if (!parent) return { error: "parent post not found" };

  // Attribute the director's answer to the post's author; default to Platform (the read-only investigation
  // brain's owner) when the parent isn't a director post.
  const directorSlug =
    parent.author === "director" && parent.authorFunction ? parent.authorFunction : "platform";
  const persona = getPersona(directorSlug);

  // Route: spec-chat when the post is about a specific spec (spec context), else dev-ask (read-only investigation).
  const specSlug = isSlug(parent.metadata.spec_slug) ? (parent.metadata.spec_slug as string) : undefined;
  const threadKind: BoardThreadKind = specSlug ? "spec-chat" : "dev-ask";

  const framed = boardQuestionPrompt({
    directorName: persona.name,
    role: persona.role,
    postBody: parent.body,
    question: input.body,
    specSlug,
  });
  const link: BoardReplyLink = {
    postId: parent.id,
    workspaceId: input.workspaceId,
    authorFunction: directorSlug,
  };
  const admin = createAdminClient();

  let threadId: string;
  if (threadKind === "spec-chat") {
    const chat = await saveChat({
      id: undefined,
      workspaceId: input.workspaceId,
      userId: input.userId,
      specSlug: specSlug ?? null,
      title: `Board: ${specSlug}`,
      messages: [{ role: "user", content: framed }],
    });
    if (!chat) return { error: "could not start spec-chat" };
    threadId = chat.id;
    await markTurnThinking(input.workspaceId, threadId);
    await admin.from("agent_jobs").insert({
      workspace_id: input.workspaceId,
      kind: "spec-chat",
      spec_slug: threadId,
      status: "queued",
      instructions: JSON.stringify({ mode: "turn", chat_id: threadId, slug: specSlug, board: link }),
      created_by: input.userId,
    });
  } else {
    const thread = await createThread({
      workspaceId: input.workspaceId,
      userId: input.userId,
      title: `Board: ${persona.role} · why?`,
      message: framed,
    });
    if (!thread) return { error: "could not start dev-ask" };
    threadId = thread.id;
    await markThreadThinking(input.workspaceId, threadId);
    await admin.from("agent_jobs").insert({
      workspace_id: input.workspaceId,
      kind: "dev-ask",
      spec_slug: threadId,
      status: "queued",
      instructions: JSON.stringify({ thread_id: threadId, mode: "turn", board: link }),
      created_by: input.userId,
    });
  }

  const ceoMessage = await postDirectorMessage({
    workspaceId: input.workspaceId,
    author: "ceo",
    body: input.body,
    kind: "reply",
    parentMessageId: parent.id,
    mentions: input.mentions ?? [directorSlug],
    metadata: { thread_id: threadId, thread_kind: threadKind },
  });

  return { ceoMessage, threadKind, threadId };
}

/**
 * Mark CEO replies whose routed answer-brain turn is still `thinking` (the director is investigating) so the
 * channel can surface it inline — mirroring the dev-message-center thinking state. Mutates the rows in place.
 */
export async function enrichAwaiting(rows: BoardMessage[]): Promise<void> {
  const devIds: string[] = [];
  const specIds: string[] = [];
  const byThread = new Map<string, BoardMessage>();
  for (const r of rows) {
    const tid = r.metadata.thread_id;
    if (typeof tid !== "string") continue;
    byThread.set(tid, r);
    if (r.metadata.thread_kind === "spec-chat") specIds.push(tid);
    else devIds.push(tid);
  }
  if (!devIds.length && !specIds.length) return;

  const admin = createAdminClient();
  const thinking = new Set<string>();
  if (devIds.length) {
    const { data } = await admin.from("dev_message_threads").select("id, turn_status").in("id", devIds);
    for (const t of (data ?? []) as { id: string; turn_status: string }[]) {
      if (t.turn_status === "thinking") thinking.add(t.id);
    }
  }
  if (specIds.length) {
    const { data } = await admin.from("roadmap_chats").select("id, turn_status").in("id", specIds);
    for (const t of (data ?? []) as { id: string; turn_status: string }[]) {
      if (t.turn_status === "thinking") thinking.add(t.id);
    }
  }
  for (const [tid, msg] of byThread) if (thinking.has(tid)) msg.awaiting = true;
}
