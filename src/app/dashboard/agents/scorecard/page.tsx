"use client";

/**
 * Platform Department Scorecard — owner-only ([[../specs/platform-scorecard-surface]] Phase 2;
 * milestone (d) of [[../goals/platform-department-scorecard]]).
 *
 * Three cadence sections (Daily pulse · Weekly throughput + quality · Monthly leading curve) of
 * KPI tiles backed by `GET /api/developer/agents/scorecard` — reads only
 * `platform_scorecard_snapshots` (the "read from the scorecard, never the raw tables" invariant
 * from [[../libraries/meta__scorecards]]), so the page can never drift from the persisted truth.
 *
 * Tile = label · current value (per `unit`) · trend arrow off `delta_pct` with per-metric polarity
 * (e.g. ↓ on human_touch_per_build is good; ↓ on build_success_rate is bad) · a sparkline from the
 * `?metric=&cadence=` history. No data yet renders muted, never a fake number (display-only proxy,
 * [[../operational-rules]] § North star). The reserved Fleet-spend tile sits at the foot of the
 * daily section — wired to light up when the cost-governor's spend metric lands in the snapshot
 * store, but renders "no data yet" today.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import {
  DAILY_DISPLAY,
  WEEKLY_DISPLAY,
  MONTHLY_DISPLAY,
  FLEET_SPEND_RESERVED,
  formatMetricValue,
  isHealthyDelta,
  type Cadence,
  type MetricDisplayDef,
} from "@/lib/agents/platform-scorecard-display";

interface ScorecardRow {
  metric_key: string;
  snapshot_date: string;
  window_days: number;
  value: number;
  prior_value: number | null;
  delta_pct: number | null;
  unit: string;
  detail: Record<string, unknown>;
}
interface ScorecardPayload {
  daily: ScorecardRow[];
  weekly: ScorecardRow[];
  monthly: ScorecardRow[];
}
interface HistoryPoint {
  snapshot_date: string;
  value: number;
}
interface HistoryPayload {
  metric: string;
  cadence: Cadence;
  history: HistoryPoint[];
}

const SECTIONS: Array<{ cadence: Cadence; title: string; subtitle: string; defs: MetricDisplayDef[] }> = [
  {
    cadence: "daily",
    title: "Daily pulse",
    subtitle: "Current-state KPIs + today's flow",
    defs: DAILY_DISPLAY,
  },
  {
    cadence: "weekly",
    title: "Weekly throughput + quality",
    subtitle: "How much the build org shipped this week, and how good it was",
    defs: WEEKLY_DISPLAY,
  },
  {
    cadence: "monthly",
    title: "Monthly leading curve",
    subtitle: "Slow-moving indicators that prove autonomy is compounding",
    defs: MONTHLY_DISPLAY,
  },
];

export default function PlatformScorecardPage() {
  const workspace = useWorkspace();
  const [data, setData] = useState<ScorecardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/developer/agents/scorecard")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: ScorecardPayload) => {
        setData(d);
        setErr(false);
      })
      .catch(() => setErr(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (workspace.role !== "owner") return;
    load();
  }, [workspace.role, load]);

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Platform scorecard</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-screen-xl p-6">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Platform scorecard</h1>
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/agents"
            className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            ← Agents hub
          </Link>
        </div>
      </div>
      <p className="mb-6 max-w-3xl text-sm text-zinc-500 dark:text-zinc-400">
        The instrument panel for the Platform department. Every tile reads the persisted, trended
        snapshot — never the raw tables — so the surface stays honest.
      </p>

      {loading && !data ? (
        <div className="py-12 text-center text-sm text-zinc-400">Loading the scorecard…</div>
      ) : err && !data ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          Couldn&apos;t load the scorecard.
        </div>
      ) : data ? (
        <div className="space-y-8">
          {SECTIONS.map((section) => (
            <ScorecardSection
              key={section.cadence}
              cadence={section.cadence}
              title={section.title}
              subtitle={section.subtitle}
              defs={section.defs}
              rows={data[section.cadence]}
              extraReserved={section.cadence === "daily" ? FLEET_SPEND_RESERVED : null}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Section ────────────────────────────────────────────────────────────────────

function ScorecardSection({
  cadence,
  title,
  subtitle,
  defs,
  rows,
  extraReserved,
}: {
  cadence: Cadence;
  title: string;
  subtitle: string;
  defs: MetricDisplayDef[];
  rows: ScorecardRow[];
  extraReserved: MetricDisplayDef | null;
}) {
  const byKey = useMemo(() => {
    const m = new Map<string, ScorecardRow>();
    for (const r of rows) m.set(r.metric_key, r);
    return m;
  }, [rows]);

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-4 flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">{title}</h2>
        <span className="text-[11px] text-zinc-400">{subtitle}</span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {defs.map((def) => (
          <KpiTile key={def.key} def={def} row={byKey.get(def.key)} cadence={cadence} />
        ))}
        {extraReserved ? (
          <KpiTile key={extraReserved.key} def={extraReserved} row={byKey.get(extraReserved.key)} cadence={cadence} reservedHint="cost governor" />
        ) : null}
      </div>
    </section>
  );
}

// ── Tile ───────────────────────────────────────────────────────────────────────

function KpiTile({
  def,
  row,
  cadence,
  reservedHint,
}: {
  def: MetricDisplayDef;
  row: ScorecardRow | undefined;
  cadence: Cadence;
  reservedHint?: string;
}) {
  const [history, setHistory] = useState<HistoryPoint[] | null>(null);
  useEffect(() => {
    if (!row) return;
    let cancelled = false;
    fetch(`/api/developer/agents/scorecard?metric=${encodeURIComponent(def.key)}&cadence=${cadence}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: HistoryPayload) => {
        if (!cancelled) setHistory(d.history ?? []);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [def.key, cadence, row]);

  if (!row) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/50">
        <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">{def.label}</p>
        <p className="mt-2 text-sm text-zinc-400">
          no data yet
          {reservedHint ? <span className="ml-1 text-[10px] text-zinc-500">· {reservedHint}</span> : null}
        </p>
      </div>
    );
  }

  const tint = isHealthyDelta(row.delta_pct, def.polarity);
  const arrow = row.delta_pct == null || row.delta_pct === 0 ? "→" : row.delta_pct > 0 ? "↑" : "↓";
  const arrowColor =
    tint === "good"
      ? "text-emerald-600 dark:text-emerald-400"
      : tint === "bad"
        ? "text-rose-600 dark:text-rose-400"
        : "text-zinc-400";
  const deltaText =
    row.delta_pct == null ? "" : `${row.delta_pct > 0 ? "+" : ""}${(row.delta_pct * 100).toFixed(1)}%`;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">{def.label}</p>
        <span className="text-[10px] text-zinc-400" title={`as of ${row.snapshot_date}, window ${row.window_days}d`}>
          {row.snapshot_date}
        </span>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <p className="text-2xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
          {formatMetricValue(row.value, row.unit)}
        </p>
        <span className={`flex items-baseline gap-0.5 text-sm font-semibold ${arrowColor}`} title={deltaText || "no prior to compare"}>
          <span aria-hidden>{arrow}</span>
          <span className="text-xs tabular-nums">{deltaText}</span>
        </span>
      </div>
      <div className="mt-2 h-8">
        <Sparkline points={history ?? []} polarity={def.polarity} />
      </div>
    </div>
  );
}

// ── Sparkline ──────────────────────────────────────────────────────────────────

function Sparkline({
  points,
  polarity,
}: {
  points: HistoryPoint[];
  polarity: "up_is_good" | "down_is_good";
}) {
  if (points.length < 2) {
    return <div className="h-full w-full" aria-hidden />;
  }
  const w = 100;
  const h = 24;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = points.length > 1 ? w / (points.length - 1) : w;
  const path = points
    .map((p, i) => {
      const x = i * stepX;
      const y = h - ((p.value - min) / range) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const first = values[0];
  const last = values[values.length - 1];
  const trendingUp = last > first;
  const isGood = polarity === "up_is_good" ? trendingUp : !trendingUp;
  const flat = last === first;
  const stroke = flat ? "rgb(161 161 170)" : isGood ? "rgb(16 185 129)" : "rgb(244 63 94)";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-full w-full" aria-hidden>
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
