"use client";

import { useEffect, useState } from "react";

/**
 * roadmap-archive-split — substring search over the archived-spec list.
 *
 * The archive used to live inside the roadmap board, where `RoadmapFilters` search matched it via
 * the shared `[data-spec-search]` attribute. Moving the archive to its own page would have dropped
 * archived specs out of search entirely, so the capability moves with the list rather than being
 * lost. Same mechanism as RoadmapFilters: match the substring against each row's `data-spec-search`
 * and toggle `hidden`, so the server-rendered list stays the single source of truth.
 */
export default function ArchiveSearch({ total }: { total: number }) {
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(total);

  useEffect(() => {
    const needle = q.trim().toLowerCase();
    let visible = 0;
    document.querySelectorAll<HTMLElement>("[data-spec-search]").forEach((el) => {
      const hay = el.dataset.specSearch ?? "";
      const match = !needle || hay.includes(needle);
      el.hidden = !match;
      if (match) visible++;
    });
    setShown(visible);
  }, [q, total]);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search archived specs…"
        aria-label="Search archived specs"
        className="w-full max-w-sm rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
      />
      <span className="tabular-nums text-xs text-zinc-400">
        {shown === total ? `${total} archived` : `${shown} of ${total}`}
      </span>
    </div>
  );
}
