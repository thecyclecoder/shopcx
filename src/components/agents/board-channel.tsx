"use client";

/**
 * BoardChannel — the Slack-style #directors team channel (directors-board-gamified spec, Phase 1).
 *
 * Renders the Messages tab of the M1 Agents-hub inbox as a conversational channel (not a log): each
 * post shows the author's persona avatar + name/role chip (from src/lib/agents/personas.ts — reskinnable,
 * never hardcoded), a human-readable body with @-mentions highlighted, a timestamp, and threaded replies.
 * Reads GET /api/developer/agents/board (owner-gated). The live Platform director (M4) is the first real
 * author; until then the system seed proves the surface. Phase 2: the owner replies / asks "why?" under a
 * post → POST routes it to the dev-ask / spec-chat answer brains; the director's answer posts back in-thread
 * (the channel polls while a routed turn is still thinking — the inline "investigating…" state).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getPersona } from "@/lib/agents/personas";
import { PersonaAvatar } from "@/components/agents/persona-chip";
import type { BoardMessage, BoardPost, BoardPayload } from "@/lib/agents/board";

function elapsed(iso: string): string {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/** Resolve the posting persona: a director by slug, the CEO seat, or a neutral system persona. */
function personaFor(msg: BoardMessage) {
  if (msg.author === "ceo") return getPersona("ceo");
  if (msg.author === "director" && msg.authorFunction) return getPersona(msg.authorFunction);
  return getPersona("system", "System");
}

const KIND_BADGE: Record<string, { label: string; cls: string }> = {
  recap: { label: "EOD recap", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" },
  "approval-note": { label: "approval", cls: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300" },
};

/** Render a body with @-mentions highlighted (Slack feel) — no markdown, just mention spans. */
function Body({ text }: { text: string }) {
  const parts = text.split(/(@[a-z0-9_-]+)/gi);
  return (
    <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-700 dark:text-zinc-200">
      {parts.map((p, i) =>
        /^@[a-z0-9_-]+$/i.test(p) ? (
          <span key={i} className="font-medium text-indigo-600 dark:text-indigo-400">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </p>
  );
}

function MessageRow({ msg, nested = false }: { msg: BoardMessage; nested?: boolean }) {
  const persona = personaFor(msg);
  const badge = KIND_BADGE[msg.kind];
  return (
    <div className="flex gap-2.5">
      <PersonaAvatar persona={persona} size={nested ? 22 : 30} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{persona.name}</span>
          <span className="text-[11px] text-zinc-400">{persona.role}</span>
          {badge && (
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}`}>{badge.label}</span>
          )}
          <span className="text-[11px] text-zinc-400">{elapsed(msg.createdAt)}</span>
        </div>
        <Body text={msg.body} />
      </div>
    </div>
  );
}

/** The inline "the director is investigating…" state under a CEO reply whose routed turn is still running. */
function Investigating({ name }: { name: string }) {
  return (
    <div className="ml-[30px] mt-1 flex items-center gap-1.5 text-[11px] text-zinc-400">
      <span className="inline-flex gap-0.5">
        <span className="h-1 w-1 animate-pulse rounded-full bg-zinc-400" />
        <span className="h-1 w-1 animate-pulse rounded-full bg-zinc-400 [animation-delay:150ms]" />
        <span className="h-1 w-1 animate-pulse rounded-full bg-zinc-400 [animation-delay:300ms]" />
      </span>
      {name} is investigating…
    </div>
  );
}

function PostBlock({
  post,
  onReply,
  sending,
}: {
  post: BoardPost;
  onReply: (parentMessageId: string, body: string) => Promise<boolean>;
  sending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const persona = personaFor(post);

  const submit = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const ok = await onReply(post.id, text);
    if (ok) {
      setDraft("");
      setOpen(false);
    }
  };

  return (
    <li className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <MessageRow msg={post} />
      {post.replies.length > 0 && (
        <ul className="ml-9 mt-3 space-y-3 border-l border-zinc-200 pl-3 dark:border-zinc-800">
          {post.replies.map((r) => (
            <li key={r.id}>
              <MessageRow msg={r} nested />
              {r.awaiting && <Investigating name={persona.name} />}
            </li>
          ))}
        </ul>
      )}
      <div className="ml-9 mt-2">
        {open ? (
          <div className="space-y-1.5">
            <textarea
              autoFocus
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder={`Reply to ${persona.name} — ask "why?" and they'll investigate…`}
              className="w-full resize-none rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-sm text-zinc-700 outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => void submit()}
                disabled={sending || !draft.trim()}
                className="rounded-md bg-indigo-600 px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50"
              >
                {sending ? "Sending…" : "Send"}
              </button>
              <button
                onClick={() => {
                  setOpen(false);
                  setDraft("");
                }}
                className="text-[12px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
              >
                Cancel
              </button>
              <span className="text-[11px] text-zinc-400">⌘↵ to send</span>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setOpen(true)}
            className="text-[12px] font-medium text-zinc-400 hover:text-indigo-600 dark:hover:text-indigo-400"
          >
            Reply
          </button>
        )}
      </div>
    </li>
  );
}

export function BoardChannel({ filter }: { filter?: string }) {
  const [posts, setPosts] = useState<BoardPost[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [sending, setSending] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(
    () =>
      fetch("/api/developer/agents/board")
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d: BoardPayload) => {
          setPosts(d.posts);
          setErr(false);
        })
        .catch(() => setErr(true))
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll while any routed answer-brain turn is still investigating, so the director's reply lands live.
  useEffect(() => {
    const awaiting = (posts ?? []).some((p) => p.replies.some((r) => r.awaiting));
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    if (awaiting) {
      pollRef.current = setTimeout(() => void refresh(), 4000);
    }
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [posts, refresh]);

  const onReply = useCallback(
    async (parentMessageId: string, body: string): Promise<boolean> => {
      setSending(true);
      try {
        const r = await fetch("/api/developer/agents/board", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parentMessageId, body }),
        });
        if (!r.ok) return false;
        await refresh();
        return true;
      } catch {
        return false;
      } finally {
        setSending(false);
      }
    },
    [refresh],
  );

  const needle = (filter ?? "").trim().toLowerCase();
  const visible = (posts ?? []).filter(
    (p) =>
      !needle ||
      p.body.toLowerCase().includes(needle) ||
      p.replies.some((r) => r.body.toLowerCase().includes(needle)),
  );

  if (loading && !posts) {
    return <div className="py-12 text-center text-sm text-zinc-400">Loading the board…</div>;
  }
  if (err) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
        Couldn&apos;t load the #directors board.
      </div>
    );
  }
  if (visible.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-200 px-4 py-10 text-center dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">The #directors board is quiet.</p>
        <p className="mx-auto mt-1 max-w-sm text-[12px] text-zinc-400">
          The directors post conversational updates here. The live Platform director (M4) is the first real author —
          until then a seeded post proves the surface.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {visible.map((p) => (
        <PostBlock key={p.id} post={p} onReply={onReply} sending={sending} />
      ))}
    </ul>
  );
}
