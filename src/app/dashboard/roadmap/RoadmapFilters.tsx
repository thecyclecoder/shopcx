"use client";

import { useState, useEffect } from "react";

/**
 * Client-side filters for the roadmap board (roadmap-goal-and-source-filters). Three filters that
 * AND together — all pure DOM, no server round-trip:
 *  - **Search** — substring over each card's `data-spec-search` (title + slug + owner + parent + summary).
 *  - **Goal** — a dropdown of every goal; pick one → only that goal's specs (cards whose space-separated
 *    `data-goal` contains the slug), plus a progress header counting the visible cards by status.
 *  - **Source** — chips (All · 🎯 Goal · 🔧 Repair · ✋ Manual) matching each card's `data-source`.
 * The goal selection is sticky in the `?goal=` URL param so a goal view is shareable/bookmarkable.
 * Replaces the old standalone SpecSearch so all three share one visibility pass (otherwise they'd
 * clobber each other's `display`).
 */

type Status = "planned" | "in_progress" | "shipped";

const SOURCES: { key: string; label: string }[] = [
  { key: "", label: "All" },
  { key: "goal", label: "🎯 Goal" },
  { key: "repair", label: "🔧 Repair" },
  { key: "manual", label: "✋ Manual" },
];

export default function RoadmapFilters({ goals }: { goals: { slug: string; title: string }[] }) {
  const [q, setQ] = useState("");
  const [goal, setGoal] = useState(""); // "" = All goals
  const [source, setSource] = useState(""); // "" = All sources
  const [count, setCount] = useState<number | null>(null);
  const [header, setHeader] = useState<{ title: string; shipped: number; building: number; planned: number; total: number } | null>(null);

  // Restore a sticky/bookmarked goal selection from the URL on mount.
  useEffect(() => {
    const g = new URLSearchParams(window.location.search).get("goal") || "";
    if (g) setGoal(g);
  }, []);

  // Persist the goal selection to the URL (shareable) without a navigation/server round-trip.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (goal) params.set("goal", goal);
    else params.delete("goal");
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [goal]);

  useEffect(() => {
    const query = q.toLowerCase().trim();
    const anyFilter = !!(query || goal || source);
    let shown = 0;
    const counts: Record<Status, number> = { planned: 0, in_progress: 0, shipped: 0 };
    document.querySelectorAll<HTMLElement>("[data-spec-search]").forEach((el) => {
      const matchSearch = !query || (el.dataset.specSearch || "").includes(query);
      const cardGoals = (el.dataset.goal || "").split(/\s+/).filter(Boolean);
      const matchGoal = !goal || cardGoals.includes(goal);
      const matchSource = !source || el.dataset.source === source;
      const hit = matchSearch && matchGoal && matchSource;
      el.style.display = hit ? "" : "none";
      if (hit) {
        if (anyFilter) shown++;
        const st = el.dataset.status as Status | undefined;
        if (st && st in counts) counts[st]++;
      }
    });
    // Auto-open the archive when searching so archived matches surface; restore on clear.
    const archive = document.getElementById("roadmap-archive") as HTMLDetailsElement | null;
    if (archive) archive.open = !!query;
    // Hide a column's empty-state placeholder while filtering (only meaningful unfiltered).
    document.querySelectorAll<HTMLElement>("[data-empty-placeholder]").forEach((el) => {
      el.style.display = anyFilter ? "none" : "";
    });
    setCount(anyFilter ? shown : null);
    // The goal-progress header counts the currently-visible cards (so it composes with source + search).
    if (goal) {
      const title = goals.find((g) => g.slug === goal)?.title || goal;
      setHeader({ title, shipped: counts.shipped, building: counts.in_progress, planned: counts.planned, total: counts.shipped + counts.in_progress + counts.planned });
    } else {
      setHeader(null);
    }
  }, [q, goal, source, goals]);

  return (
    <div className="mb-5 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
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
        <select
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          className="rounded-lg border border-zinc-200 bg-white py-2 pl-3 pr-8 text-sm text-zinc-800 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        >
          <option value="">All goals</option>
          {goals.map((g) => (
            <option key={g.slug} value={g.slug}>
              {g.title}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          {SOURCES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSource(s.key)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                source === s.key
                  ? "border-indigo-400 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-900/30 dark:text-indigo-300"
                  : "border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {count !== null && (
          <span className="whitespace-nowrap text-xs text-zinc-400">{count} match{count === 1 ? "" : "es"}</span>
        )}
      </div>
      {header && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-300">
          <span className="font-semibold">{header.title}</span>
          {" — "}
          <span className="tabular-nums">{header.shipped}/{header.total}</span> shipped
          {" · "}
          <span className="tabular-nums">{header.building}</span> building
          {" · "}
          <span className="tabular-nums">{header.planned}</span> planned
        </div>
      )}
    </div>
  );
}
