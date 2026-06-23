"use client";

/**
 * BoardChannel — the Slack-style #directors team channel (directors-board-gamified spec, Phase 1).
 *
 * Renders the Messages tab of the M1 Agents-hub inbox as a conversational channel (not a log): each
 * post shows the author's persona avatar + name/role chip (from src/lib/agents/personas.ts — reskinnable,
 * never hardcoded), a human-readable body with @-mentions highlighted, a timestamp, and threaded replies.
 * Reads GET /api/developer/agents/board (owner-gated). The live Platform director (M4) is the first real
 * author; until then the system seed proves the surface. Two-way reply is Phase 2.
 */
import { useCallback, useEffect, useState } from "react";
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

function PostBlock({ post }: { post: BoardPost }) {
  return (
    <li className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <MessageRow msg={post} />
      {post.replies.length > 0 && (
        <ul className="ml-9 mt-3 space-y-3 border-l border-zinc-200 pl-3 dark:border-zinc-800">
          {post.replies.map((r) => (
            <li key={r.id}>
              <MessageRow msg={r} nested />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function BoardChannel({ filter }: { filter?: string }) {
  const [posts, setPosts] = useState<BoardPost[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);

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
        <PostBlock key={p.id} post={p} />
      ))}
    </ul>
  );
}
