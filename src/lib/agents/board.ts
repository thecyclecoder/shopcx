/**
 * Director board — client-safe types + threading helper (directors-board-gamified spec, Phase 1).
 *
 * The Messages tab of the M1 Agents-hub inbox is a Slack-style TEAM CHANNEL backed by the
 * [[director_messages]] table: each director is a character (persona from ./personas) posting
 * conversational updates, with threading + @-mentions. This file is the CLIENT-SAFE shape (no
 * server imports) the channel component + the board API agree on; the admin reads/writes live in
 * ./director-board.ts (server only). See docs/brain/tables/director_messages.md.
 */

export type BoardAuthor = "director" | "ceo" | "system";
export type BoardMessageKind = "update" | "reply" | "recap" | "approval-note";

/** A single director_messages row, camelCased for the client. */
export interface BoardMessage {
  id: string;
  /** who posted: a director (with authorFunction), the CEO, or the system seed. */
  author: BoardAuthor;
  /** the function slug for a director post (e.g. "platform") — null for ceo/system. Resolves a persona. */
  authorFunction: string | null;
  body: string;
  kind: BoardMessageKind;
  /** the post this answers (null = a top-level channel post). */
  parentMessageId: string | null;
  /** @-mentioned handles/slugs. */
  mentions: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** A top-level post with its in-thread replies nested (the rendered channel shape). */
export interface BoardPost extends BoardMessage {
  replies: BoardMessage[];
}

export interface BoardPayload {
  posts: BoardPost[];
}

/**
 * Thread a flat list of messages into the channel shape: top-level posts (no parent) newest-first,
 * each with its replies oldest-first. A reply whose parent isn't in the set is promoted to top-level
 * (so an orphaned reply never silently disappears). Pure — shared by the API and any future SSR.
 */
export function threadMessages(rows: BoardMessage[]): BoardPost[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const repliesByParent = new Map<string, BoardMessage[]>();
  const tops: BoardMessage[] = [];

  for (const r of rows) {
    if (r.parentMessageId && byId.has(r.parentMessageId)) {
      const arr = repliesByParent.get(r.parentMessageId) ?? [];
      arr.push(r);
      repliesByParent.set(r.parentMessageId, arr);
    } else {
      tops.push(r);
    }
  }

  const asc = (a: BoardMessage, b: BoardMessage) => a.createdAt.localeCompare(b.createdAt);
  const desc = (a: BoardMessage, b: BoardMessage) => b.createdAt.localeCompare(a.createdAt);

  return tops
    .sort(desc)
    .map((t) => ({ ...t, replies: (repliesByParent.get(t.id) ?? []).sort(asc) }));
}
