"use client";

import { useCallback, useEffect, useState, use } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface CommentDetail {
  id: string;
  meta_page_id: string;
  meta_comment_id: string;
  meta_post_id: string;
  meta_sender_id: string;
  meta_sender_name: string | null;
  meta_sender_username: string | null;
  body: string;
  is_ad: boolean;
  page_type: string;
  ad_id: string | null;
  sentiment: string | null;
  status: string;
  moderation_source: string | null;
  ai_action: string | null;
  ai_reply_body: string | null;
  ai_reasoning: string | null;
  ai_ran_at: string | null;
  liked_at: string | null;
  hidden_at: string | null;
  deleted_at: string | null;
  replied_at: string | null;
  created_at: string;
  meta_pages: { meta_page_name: string | null; platform: string; page_type: string };
  products: { title: string; handle: string; description: string | null } | null;
  meta_post_cache: {
    permalink_url: string | null;
    message: string | null;
    image_url: string | null;
    posted_at: string | null;
    is_ad: boolean | null;
  } | null;
}

interface ReplyRow {
  id: string;
  meta_reply_id: string | null;
  meta_sender_name: string | null;
  direction: "inbound" | "outbound";
  author_type: "customer" | "agent" | "ai" | "system";
  body: string;
  send_status: string | null;
  send_error: string | null;
  created_at: string;
}

interface SenderHistoryRow {
  id: string;
  body: string;
  status: string;
  sentiment: string | null;
  created_at: string;
}

export default function SocialCommentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { id: workspaceId } = useWorkspace();

  const [comment, setComment] = useState<CommentDetail | null>(null);
  const [replies, setReplies] = useState<ReplyRow[]>([]);
  const [senderHistory, setSenderHistory] = useState<SenderHistoryRow[]>([]);
  const [senderBanned, setSenderBanned] = useState(false);
  const [loading, setLoading] = useState(true);
  const [replyBody, setReplyBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/workspaces/${workspaceId}/social-comments/${id}`);
    if (!res.ok) {
      setLoading(false);
      return;
    }
    const data = await res.json();
    setComment(data.comment);
    setReplies(data.replies || []);
    setSenderHistory(data.sender_history || []);
    setSenderBanned(!!data.sender_banned);
    setLoading(false);
  }, [id, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: string, payload?: Record<string, unknown>) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/social-comments/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Action failed");
        return false;
      }
      return true;
    } finally {
      setSubmitting(false);
    }
  }

  async function sendReply() {
    if (!replyBody.trim()) return;
    if (!(await act("reply", { reply_body: replyBody.trim() }))) return;
    setReplyBody("");
    await load();
  }

  async function applyAiSuggestion() {
    if (!comment?.ai_action) return;
    if (!(await act(comment.ai_action, { reply_body: comment.ai_reply_body }))) return;
    await load();
  }

  if (loading) {
    return <div className="p-8 text-center text-sm text-zinc-500">Loading…</div>;
  }
  if (!comment) {
    return (
      <div className="p-8 text-center text-sm text-zinc-500">
        Comment not found.{" "}
        <Link href="/dashboard/social-comments" className="text-blue-600 hover:underline">
          Back to list
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <div>
            <Link
              href="/dashboard/social-comments"
              className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              ← Back to all comments
            </Link>
            <h1 className="mt-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              Comment from {comment.meta_sender_name || "(anon)"}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={comment.status} />
            {comment.sentiment && <SentimentBadge sentiment={comment.sentiment} />}
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Center column — thread */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 space-y-4 overflow-auto p-6">
            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
                {error}
              </div>
            )}

            {/* Original comment */}
            <MessageBubble
              author={comment.meta_sender_name || "(anon)"}
              authorMeta={comment.meta_sender_username ? `@${comment.meta_sender_username}` : null}
              body={comment.body}
              ts={comment.created_at}
              side="inbound"
            />

            {/* Thread replies */}
            {replies.map(r => (
              <MessageBubble
                key={r.id}
                author={
                  r.direction === "outbound"
                    ? r.author_type === "ai"
                      ? "AI (Suzie)"
                      : "Agent"
                    : r.meta_sender_name || "(anon)"
                }
                authorMeta={r.send_status === "failed" ? `failed: ${r.send_error || "unknown"}` : null}
                body={r.body}
                ts={r.created_at}
                side={r.direction === "outbound" ? "outbound" : "inbound"}
              />
            ))}
          </div>

          {/* Composer */}
          <div className="border-t border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <textarea
              value={replyBody}
              onChange={e => setReplyBody(e.target.value)}
              placeholder="Write a public reply…"
              rows={3}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
            <div className="mt-2 flex items-center justify-between">
              <p className="text-xs text-zinc-500">
                Replies are public on {comment.meta_pages.platform === "instagram" ? "Instagram" : "Facebook"}.
                Plain text only — Meta strips formatting.
              </p>
              <button
                type="button"
                disabled={submitting || !replyBody.trim()}
                onClick={sendReply}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
              >
                Send reply
              </button>
            </div>
          </div>
        </div>

        {/* Right sidebar — moderation context */}
        <aside className="w-80 shrink-0 border-l border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950 overflow-auto">
          <div className="space-y-4">
            {/* Moderation actions — pinned at top for fast triage */}
            <Card title="Moderation actions" accent="purple">
              <div className="grid grid-cols-2 gap-2">
                <ActionButton onClick={() => act("like").then(load)} disabled={submitting}>
                  Like
                </ActionButton>
                <ActionButton onClick={() => act("hide").then(load)} disabled={submitting}>
                  Hide
                </ActionButton>
                <ActionButton
                  onClick={() => {
                    if (confirm("Delete this comment from Meta? This can't be undone.")) {
                      act("delete").then(load);
                    }
                  }}
                  disabled={submitting}
                  tone="danger"
                >
                  Delete
                </ActionButton>
                <ActionButton onClick={() => act("ignore").then(load)} disabled={submitting}>
                  Ignore
                </ActionButton>
                <ActionButton
                  onClick={() => act("escalate").then(load)}
                  disabled={submitting}
                >
                  Escalate
                </ActionButton>
              </div>
            </Card>

            {/* Commenter — pinned near top alongside actions */}
            <Card title="Commenter">
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {comment.meta_sender_name || "(name unknown)"}
              </p>
              {comment.meta_sender_username && (
                <p className="text-xs text-zinc-500">@{comment.meta_sender_username}</p>
              )}
              <p className="mt-2 text-xs text-zinc-500">
                {senderHistory.length} other comment{senderHistory.length === 1 ? "" : "s"} from this user
              </p>
              {senderBanned ? (
                <button
                  type="button"
                  disabled={submitting}
                  onClick={async () => {
                    if (await act("unban")) await load();
                  }}
                  className="mt-2 w-full rounded-md border border-emerald-300 px-3 py-1.5 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-400"
                >
                  Unban user
                </button>
              ) : (
                <button
                  type="button"
                  disabled={submitting}
                  onClick={async () => {
                    const reason = prompt("Reason for ban (optional):");
                    if (reason === null) return;
                    if (await act("ban", { ban_reason: reason })) await load();
                  }}
                  className="mt-2 w-full rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400"
                >
                  Ban this user
                </button>
              )}
            </Card>

            {/* AI suggestion */}
            {comment.ai_action && (
              <Card title="AI suggestion" accent="purple">
                <p className="text-sm font-medium capitalize text-zinc-900 dark:text-zinc-100">
                  Action: {comment.ai_action}
                </p>
                {comment.ai_reasoning && (
                  <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{comment.ai_reasoning}</p>
                )}
                {comment.ai_reply_body && (
                  <div className="mt-2 rounded-md bg-white p-2 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                    {comment.ai_reply_body}
                  </div>
                )}
                {comment.moderation_source === "ai_suggested" && (
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={applyAiSuggestion}
                    className="mt-2 w-full rounded-md bg-purple-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-50"
                  >
                    Approve & {comment.ai_action}
                  </button>
                )}
              </Card>
            )}

            {/* Post context */}
            <Card title="Post">
              {comment.meta_post_cache?.image_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={comment.meta_post_cache.image_url}
                  alt=""
                  className="mb-2 w-full rounded-md"
                />
              )}
              <p className="text-xs text-zinc-600 dark:text-zinc-400 line-clamp-4">
                {comment.meta_post_cache?.message || "(no caption cached)"}
              </p>
              <div className="mt-2 flex flex-wrap gap-1">
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                  {comment.meta_pages.platform}
                </span>
                <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {comment.is_ad ? "Ad" : "Organic"}
                </span>
                <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {comment.page_type}
                </span>
              </div>
              <p className="mt-2 text-xs text-zinc-500">
                Page: {comment.meta_pages.meta_page_name || "Unknown"}
              </p>
              {comment.meta_post_cache?.permalink_url && (
                <a
                  href={comment.meta_post_cache.permalink_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 block text-xs text-blue-600 hover:underline"
                >
                  View on {comment.meta_pages.platform === "instagram" ? "Instagram" : "Facebook"} →
                </a>
              )}
            </Card>

            {/* Product */}
            {comment.products && (
              <Card title="Matched product">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{comment.products.title}</p>
                <Link
                  href={`/dashboard/products?handle=${comment.products.handle}`}
                  className="mt-1 block text-xs text-blue-600 hover:underline"
                >
                  View product →
                </Link>
              </Card>
            )}

            {/* Audit log */}
            <Card title="Audit">
              <div className="space-y-1 text-xs text-zinc-500">
                <p>Created {formatDateTime(comment.created_at)}</p>
                {comment.ai_ran_at && <p>AI ran {formatDateTime(comment.ai_ran_at)}</p>}
                {comment.replied_at && <p>Replied {formatDateTime(comment.replied_at)}</p>}
                {comment.hidden_at && <p>Hidden {formatDateTime(comment.hidden_at)}</p>}
                {comment.deleted_at && <p>Deleted {formatDateTime(comment.deleted_at)}</p>}
                {comment.liked_at && <p>Liked {formatDateTime(comment.liked_at)}</p>}
                {comment.moderation_source && <p>Source: {comment.moderation_source}</p>}
              </div>
            </Card>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Card({
  title,
  children,
  accent,
}: {
  title: string;
  children: React.ReactNode;
  accent?: "purple";
}) {
  const accentClass = accent === "purple"
    ? "border-purple-200 dark:border-purple-900"
    : "border-zinc-200 dark:border-zinc-800";
  return (
    <div className={`rounded-lg border bg-white p-3 dark:bg-zinc-900 ${accentClass}`}>
      <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</h3>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function MessageBubble({
  author,
  authorMeta,
  body,
  ts,
  side,
}: {
  author: string;
  authorMeta?: string | null;
  body: string;
  ts: string;
  side: "inbound" | "outbound";
}) {
  return (
    <div className={`flex ${side === "outbound" ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 ${
          side === "outbound"
            ? "bg-blue-600 text-white"
            : "bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100 border border-zinc-200 dark:border-zinc-800"
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <p className={`text-xs font-medium ${side === "outbound" ? "text-blue-100" : "text-zinc-500"}`}>
            {author}
            {authorMeta && <span className="ml-1 opacity-75">· {authorMeta}</span>}
          </p>
          <p className={`text-xs ${side === "outbound" ? "text-blue-100" : "text-zinc-400"}`}>
            {formatDateTime(ts)}
          </p>
        </div>
        <p className="mt-1 whitespace-pre-wrap text-sm">{body}</p>
      </div>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "danger";
}) {
  const colorClass = tone === "danger"
    ? "border-red-300 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
    : "border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${colorClass}`}
    >
      {children}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    open: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    replied: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
    hidden: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
    deleted: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    escalated: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    ignored: "bg-zinc-50 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] || colors.open}`}>
      {status}
    </span>
  );
}

function SentimentBadge({ sentiment }: { sentiment: string }) {
  const colors: Record<string, string> = {
    positive: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
    negative: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400",
    neutral: "bg-zinc-50 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
    spam: "bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-400",
    abusive: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-400",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${colors[sentiment] || colors.neutral}`}>
      {sentiment}
    </span>
  );
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
