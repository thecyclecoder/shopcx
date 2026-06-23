"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import type { DayNarrative, DirectorDayNarrative } from "@/lib/agents/director-recap";

// The human-readable EOD recap detail page (director-loop-grading spec, Phase 5).
// `/dashboard/agents/recap/{date}?function={slug}` — the drill-down a Daily Summaries row deep-links to.
// A readable narrative of the director's day (what it fixed + why, which goal it moved + how far, what it
// escalated), read fresh from that day's director_activity rows via GET /api/developer/agents/recap.
// With `function` → one director; without → every active director (the CEO company roll-up).

function DirectorDay({ d }: { d: DirectorDayNarrative }) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-xl" aria-hidden>
          {d.personaEmoji}
        </span>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{d.personaName}</h2>
        <span className="text-sm text-zinc-400">· {d.personaRole}</span>
        <span className="ml-auto text-[12px] text-zinc-400">{d.headline}</span>
      </div>

      <div className="mt-4 space-y-5">
        {d.groups.map((g) => (
          <div key={g.category}>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
              {g.category}
              <span className="ml-1.5 tabular-nums text-zinc-300 dark:text-zinc-600">{g.items.length}</span>
            </h3>
            <ul className="space-y-2">
              {g.items.map((it, i) => (
                <li
                  key={i}
                  className="flex gap-2.5 rounded-lg border border-zinc-200 bg-zinc-50/60 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40"
                >
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
                  <span className="min-w-0">
                    <span className="block text-sm text-zinc-800 dark:text-zinc-200">
                      {it.actionLabel}
                      {it.specSlug && (
                        <span className="ml-1.5 font-mono text-[11px] text-zinc-400">{it.specSlug}</span>
                      )}
                    </span>
                    {it.reason && (
                      <span className="mt-0.5 block text-[12px] text-zinc-500 dark:text-zinc-400">{it.reason}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function RecapDetail() {
  const params = useParams<{ date: string }>();
  const date = decodeURIComponent(params.date);
  const search = useSearchParams();
  const functionSlug = search.get("function");
  const workspace = useWorkspace();

  const [data, setData] = useState<DayNarrative | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ date });
    if (functionSlug) qs.set("function", functionSlug);
    return fetch(`/api/developer/agents/recap?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: DayNarrative) => {
        setData(d);
        setErr(false);
      })
      .catch(() => setErr(true))
      .finally(() => setLoading(false));
  }, [date, functionSlug]);

  useEffect(() => {
    if (workspace.role !== "owner") return;
    load();
  }, [workspace.role, load]);

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Agents</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
      </div>
    );
  }

  const title = functionSlug ? "Director recap" : "Company standup";

  return (
    <div className="mx-auto w-full max-w-screen-lg p-6">
      <div className="mb-5 flex items-center gap-2 text-[12px] text-zinc-400">
        <Link href="/dashboard/agents?view=inbox&role=ceo" className="hover:text-zinc-700 dark:hover:text-zinc-200">
          Agents
        </Link>
        <span>/</span>
        <span className="text-zinc-500 dark:text-zinc-300">recap</span>
        <span>/</span>
        <span className="text-zinc-500 dark:text-zinc-300">{date}</span>
      </div>

      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{title}</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {date} · a readable narrative of the day, read from the activity log.
      </p>

      <div className="mt-6">
        {loading && !data ? (
          <div className="py-12 text-center text-sm text-zinc-400">Loading the day…</div>
        ) : err && !data ? (
          <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
            Couldn&apos;t load the recap.
          </div>
        ) : data && !data.empty ? (
          <div className="space-y-4">
            {data.directors.map((d) => (
              <DirectorDay key={d.functionSlug} d={d} />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-zinc-200 px-4 py-12 text-center dark:border-zinc-800">
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">A quiet day.</p>
            <p className="mt-1 text-[12px] text-zinc-400">No director activity was logged on {date}.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function RecapDetailPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<div className="py-12 text-center text-sm text-zinc-400">Loading…</div>}>
      <RecapDetail />
    </Suspense>
  );
}
