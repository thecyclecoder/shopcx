"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { DAILY_DISPLAY, formatMetricValue, isHealthyDelta } from "@/lib/agents/platform-scorecard-display";

interface Row {
  metric_key: string;
  value: number;
  delta_pct: number | null;
  unit: string;
}
interface Payload {
  daily: Row[];
  weekly: Row[];
  monthly: Row[];
}

/**
 * Compact DevOps-department KPI strip for the Platform Director's profile Overview — the daily-pulse KPIs
 * (loop health, error backlog/MTTR, builds shipped, lane utilization) at a glance, linking to the full
 * scorecard. Reuses the same DAILY_DISPLAY defs + formatters as /dashboard/agents/scorecard so the numbers
 * + polarity match exactly. Owner-only (the scorecard API is owner-gated). See platform-scorecard.
 */
export default function DepartmentScorecardCard() {
  const workspace = useWorkspace();
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (workspace.role !== "owner") return;
    fetch("/api/developer/agents/scorecard")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: Payload) => setData(d))
      .catch(() => setErr(true));
  }, [workspace.role]);

  if (workspace.role !== "owner") return null;

  const byKey = new Map((data?.daily ?? []).map((r) => [r.metric_key, r]));

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Department KPIs · daily pulse</h2>
        <Link href="/dashboard/agents/scorecard" className="text-[11px] text-indigo-500 hover:text-indigo-400">
          Full scorecard →
        </Link>
      </div>
      {err ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Scorecard unavailable.</p>
      ) : !data ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {DAILY_DISPLAY.map((def) => {
            const row = byKey.get(def.key);
            const tint = row ? isHealthyDelta(row.delta_pct, def.polarity) : "neutral";
            const arrow = !row || row.delta_pct == null || row.delta_pct === 0 ? "→" : row.delta_pct > 0 ? "↑" : "↓";
            const tc = tint === "good" ? "text-emerald-600 dark:text-emerald-400" : tint === "bad" ? "text-rose-600 dark:text-rose-400" : "text-zinc-400";
            return (
              <div key={def.key} className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">{def.label}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                  {row ? formatMetricValue(row.value, row.unit) : "—"}
                </p>
                {row?.delta_pct != null && (
                  <p className={`text-[11px] tabular-nums ${tc}`}>
                    {arrow} {Math.abs(row.delta_pct).toFixed(0)}%
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
