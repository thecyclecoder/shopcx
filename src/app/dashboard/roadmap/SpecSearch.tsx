"use client";

import { useState, useEffect } from "react";

/**
 * Client-side filter for the roadmap board. Replaces the (unhelpful) track pills.
 * Every spec card (active columns) and every archived row carries a `data-spec-search`
 * attribute (lowercased title + slug + owner + parent + summary). Typing here hides the
 * non-matching ones across BOTH the active board and the archived list — and auto-opens
 * the Archived <details> so archived matches surface. Pure DOM filter: no server round-trip.
 */
export default function SpecSearch() {
  const [q, setQ] = useState("");
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    const query = q.toLowerCase().trim();
    let shown = 0;
    document.querySelectorAll<HTMLElement>("[data-spec-search]").forEach((el) => {
      const hit = !query || (el.dataset.specSearch || "").includes(query);
      el.style.display = hit ? "" : "none";
      if (hit && query) shown++;
    });
    // Auto-open the archive when searching so archived matches are visible; restore on clear.
    const archive = document.getElementById("roadmap-archive") as HTMLDetailsElement | null;
    if (archive) archive.open = query ? true : false;
    // Hide a column's empty-state placeholder while filtering (it's only meaningful unfiltered).
    document.querySelectorAll<HTMLElement>("[data-empty-placeholder]").forEach((el) => {
      el.style.display = query ? "none" : "";
    });
    setCount(query ? shown : null);
  }, [q]);

  return (
    <div className="mb-5 flex items-center gap-2">
      <div className="relative w-full max-w-md">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400">⌕</span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search specs — title, slug, owner… (active + archived)"
          className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        />
      </div>
      {count !== null && (
        <span className="whitespace-nowrap text-xs text-zinc-400">{count} match{count === 1 ? "" : "es"}</span>
      )}
    </div>
  );
}
