"use client";

/**
 * SessionChecklist — the live TodoWrite mirror surfaced on every active box session
 * ([[../../docs/brain/specs/box-session-transparency]] Phase 2).
 *
 * Phase 1 wired the shared `runBoxSession` runner (scripts/builder-worker.ts) to parse each session's
 * stream-json `TodoWrite` events and stream the resulting checklist + the current one-line note onto
 * the `agent_jobs.session_checklist` + `agent_jobs.session_note` columns. Before Phase 2 the box
 * card just said "building…" and the actual plan never reached a human eye — the opposite of the
 * north star. This component is the surface: every box-card chip that shows an ACTIVE job (the
 * roadmap-card BuildButton + each live lane on /dashboard/roadmap/box) renders it.
 *
 * Compact form: the current one-line note (the in-progress TodoWrite `activeForm`).
 * Expand: the full checklist with pending/in_progress/done state — what was done, what's next.
 *
 * No props mutate state; this is a read-only render of polled job state. The parent's existing poll
 * loop already drives liveness, so the chip re-renders as the agent ticks through its todos.
 */
import { useState } from "react";
import type { SessionChecklistItem } from "@/lib/agent-jobs";

const STATUS_GLYPH: Record<SessionChecklistItem["status"], string> = {
  pending: "○",
  in_progress: "◐",
  done: "●",
};

const STATUS_CLS: Record<SessionChecklistItem["status"], string> = {
  pending: "text-zinc-400 dark:text-zinc-500",
  in_progress: "text-amber-600 dark:text-amber-400",
  done: "text-emerald-600 dark:text-emerald-400",
};

const ROW_CLS: Record<SessionChecklistItem["status"], string> = {
  pending: "text-zinc-500 dark:text-zinc-400",
  in_progress: "font-medium text-zinc-800 dark:text-zinc-100",
  done: "text-zinc-500 line-through decoration-zinc-300 dark:text-zinc-500 dark:decoration-zinc-600",
};

export function SessionChecklist({
  note,
  checklist,
  density = "card",
}: {
  note: string | null | undefined;
  checklist: SessionChecklistItem[] | null | undefined;
  // "card" = the BuildButton's spec card (a touch more breathing room); "lane" = the box-page lane
  // tile (tighter, sits under the lane's existing one-line action label).
  density?: "card" | "lane";
}) {
  const [open, setOpen] = useState(false);

  const items = checklist ?? [];
  const hasItems = items.length > 0;
  // The note we render in the compact line: the streamed session_note (in-progress activeForm), with
  // a fall back to the in_progress / last item's note so an early-stream lane with only a checklist
  // still shows SOMETHING informative.
  const trimmedNote = (note ?? "").trim();
  const fallback =
    items.find((i) => i.status === "in_progress")?.note?.trim() ||
    items[items.length - 1]?.note?.trim() ||
    "";
  const shown = trimmedNote || fallback;

  // Nothing to show — the runner hasn't emitted a TodoWrite yet, or this is a pre-Phase-1 job row.
  // Render nothing so the card just falls back to whatever label its parent already shows.
  if (!shown && !hasItems) return null;

  const done = items.filter((i) => i.status === "done").length;
  const total = items.length;

  const tight = density === "lane";
  const noteCls = tight
    ? "truncate text-[11px] italic text-zinc-600 dark:text-zinc-300"
    : "truncate text-[11px] italic text-zinc-600 dark:text-zinc-300";
  const buttonCls = tight
    ? "shrink-0 text-[10px] font-medium text-zinc-400 hover:text-indigo-600 dark:hover:text-indigo-400"
    : "shrink-0 text-[10px] font-medium text-zinc-500 hover:text-indigo-600 dark:hover:text-indigo-400";

  return (
    <div className={tight ? "" : "mt-2"}>
      <div className="flex items-center gap-2">
        {shown && (
          <span className={noteCls} title={shown}>
            {shown}
          </span>
        )}
        {hasItems && (
          <button
            type="button"
            onClick={(e) => {
              // The lane card wraps its body in a <Link> — don't follow the link when the user only
              // wanted to peek at the checklist.
              e.preventDefault();
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            aria-expanded={open}
            className={buttonCls}
            title={open ? "Hide the live checklist" : "Show the live checklist"}
          >
            {open ? "▴ hide" : `▾ ${done}/${total}`}
          </button>
        )}
      </div>
      {open && hasItems && (
        <ul className="mt-1.5 space-y-0.5 rounded-md border border-zinc-200 bg-zinc-50/60 px-2 py-1.5 text-[11px] leading-snug dark:border-zinc-800 dark:bg-zinc-900/60">
          {items.map((it, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <span className={`shrink-0 ${STATUS_CLS[it.status]}`} aria-label={it.status}>
                {STATUS_GLYPH[it.status]}
              </span>
              <span className={`min-w-0 ${ROW_CLS[it.status]}`}>{it.step}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
