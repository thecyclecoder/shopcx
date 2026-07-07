"use client";

/**
 * /dashboard/tickets/analytics — measurement surface for the confidence-gated
 * problem-lockin + selective-clarify Phase 2 spec.
 *
 * One card today: "Selective-clarify rate (target ~6%)" — driven by
 * public.ticket_resolution_events.verified_outcome='clarified' over a 7-day window
 * via /api/tickets/analytics/selective-clarify. If the rate climbs toward 38%,
 * we're back in the blanket-clarify regime the parent goal rejects — that's the
 * cue to tighten IRREVERSIBLE_SET or drop the clarify-below threshold via policies.
 */
import { useEffect, useState } from "react";
import { Suspense } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface SelectiveClarify {
  window_days: number;
  total: number;
  clarified: number;
  rate: number;
  by_outcome: Record<string, number>;
  target: number;
}

function AnalyticsInner() {
  const workspace = useWorkspace();
  const [data, setData] = useState<SelectiveClarify | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetch("/api/tickets/analytics/selective-clarify")
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((d) => { if (alive) setData(d as SelectiveClarify); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : "load failed"); });
    return () => { alive = false; };
  }, []);

  if (!["owner", "admin", "cs_manager"].includes(workspace.role)) {
    return <p className="p-4 text-sm text-zinc-500">Owner, admin, or CS manager role required.</p>;
  }

  const ratePct = data ? (data.rate * 100).toFixed(1) : "—";
  const targetPct = data ? (data.target * 100).toFixed(0) : "6";
  const onTarget = data ? Math.abs(data.rate - data.target) <= 0.03 : false;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Ticket analytics</h1>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Signals over the last 7 days of resolution events.
      </p>

      <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
            Selective-clarify rate <span className="text-zinc-400">(target ~{targetPct}%)</span>
          </p>
          {data && (
            <span
              className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                onTarget
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                  : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
              }`}
            >
              {onTarget ? "on target" : "off target"}
            </span>
          )}
        </div>
        <p className="mt-2 text-4xl font-semibold text-zinc-900 dark:text-zinc-100">
          {ratePct}%
        </p>
        {data && (
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {data.clarified.toLocaleString()} clarified of {data.total.toLocaleString()} resolution events over {data.window_days} days.
          </p>
        )}
        {data && (
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
            {(["confirmed", "clarified", "drifted", "unbacked", "unknown"] as const).map((k) => (
              <div key={k} className="rounded border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-950">
                <p className="text-[10px] uppercase tracking-wide text-zinc-500">{k}</p>
                <p className="mt-0.5 font-mono text-sm text-zinc-800 dark:text-zinc-200">
                  {(data.by_outcome[k] ?? 0).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        )}
        {error && (
          <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">Couldn&apos;t load ({error}).</p>
        )}
        {!data && !error && (
          <p className="mt-2 text-xs text-zinc-400">Loading…</p>
        )}
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  // cacheComponents: this page reads dynamic (auth + DB) data via a fetch inside a
  // client component. Wrap in <Suspense> so the production build's uncached-data
  // check doesn't reject the segment (see CLAUDE.md § cacheComponents RULES).
  return (
    <Suspense fallback={null}>
      <AnalyticsInner />
    </Suspense>
  );
}
