"use client";

import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface MonthData {
  month: string;
  recurring_count: number;
  recurring_revenue_cents: number;
  new_subscription_count: number;
  new_subscription_revenue_cents: number;
  one_time_count: number;
  one_time_revenue_cents: number;
  replacement_count: number;
  total_count: number;
  total_revenue_cents: number;
  mrr_cents: number;
  churn_cents: number;
  churn_pct: number;
  prev_mrr_cents: number;
  net_mrr_cents: number;
  subscription_rate: number;
  is_complete: boolean;
  days: number;
  days_in_month: number;
  mismatches: number;
}

function fmt(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtShort(cents: number): string {
  if (Math.abs(cents) >= 100000) return "$" + (cents / 100000).toFixed(1) + "K";
  return fmt(cents);
}

export default function RevenueDashboard() {
  const workspace = useWorkspace();
  const [months, setMonths] = useState<MonthData[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(
      `/api/workspaces/${workspace.id}/analytics/revenue?mode=monthly&months=16`
    );
    if (res.ok) {
      const data = await res.json();
      setMonths(data.months || []);
    }
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => { load(); }, [load]);

  // Find the last complete month for default summary
  const completeMonths = months.filter(m => m.is_complete);
  const currentMonth = months.find(m => !m.is_complete);
  const lastComplete = completeMonths.length > 0 ? completeMonths[completeMonths.length - 1] : null;

  // Churn trendline data — only complete months
  const trendData = completeMonths.filter(m => m.churn_pct > 0 || m.prev_mrr_cents > 0);

  const monthLabel = (m: string) => {
    const [y, mo] = m.split("-").map(Number);
    return new Date(y, mo - 1).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Revenue Analytics</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Monthly revenue breakdown with churn tracking.
          {lastComplete && <span> Showing data through <b>{monthLabel(lastComplete.month)}</b> (last complete month).</span>}
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-400">Loading...</p>
      ) : (
        <>
          {/* Summary cards — last complete month */}
          {lastComplete && (
            <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-5">
              <StatCard label="MRR" value={fmtShort(lastComplete.mrr_cents)} sub={monthLabel(lastComplete.month)} color="text-emerald-600 dark:text-emerald-400" />
              <StatCard label="Churn" value={fmtShort(lastComplete.churn_cents)} sub={`${lastComplete.churn_pct.toFixed(1)}%`} color="text-red-600 dark:text-red-400" />
              <StatCard label="Net MRR" value={fmtShort(lastComplete.net_mrr_cents)} sub={`After churn`} color="text-zinc-900 dark:text-zinc-100" />
              <StatCard label="New Subs" value={fmtShort(lastComplete.new_subscription_revenue_cents)} sub={`${lastComplete.new_subscription_count} orders`} color="text-blue-600 dark:text-blue-400" />
              <StatCard label="Sub Rate" value={`${lastComplete.subscription_rate.toFixed(0)}%`} sub="of checkout revenue" color="text-violet-600 dark:text-violet-400" />
            </div>
          )}

          {/* Current month in-progress card */}
          {currentMonth && (
            <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                    {monthLabel(currentMonth.month)} — In Progress ({currentMonth.days}/{currentMonth.days_in_month} days)
                  </p>
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    MRR so far: {fmt(currentMonth.mrr_cents)} · Recurring: {fmt(currentMonth.recurring_revenue_cents)} · New subs: {fmt(currentMonth.new_subscription_revenue_cents)} · One-time: {fmt(currentMonth.one_time_revenue_cents)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold tabular-nums text-amber-800 dark:text-amber-200">{fmt(currentMonth.total_revenue_cents)}</p>
                  <p className="text-[10px] text-amber-600">{currentMonth.total_count} orders</p>
                </div>
              </div>
            </div>
          )}

          {/* Churn trendline */}
          {trendData.length > 1 && (
            <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Churn Trend</h2>
              <ChurnChart data={trendData} />
            </div>
          )}

          {/* Monthly table */}
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800">
                  <th className="px-4 py-2">Month</th>
                  <th className="px-4 py-2 text-right">Recurring</th>
                  <th className="px-4 py-2 text-right">New Subs</th>
                  <th className="px-4 py-2 text-right">MRR</th>
                  <th className="px-4 py-2 text-right">Churn</th>
                  <th className="px-4 py-2 text-right">Churn %</th>
                  <th className="px-4 py-2 text-right">One-Time</th>
                  <th className="px-4 py-2 text-right">Sub Rate</th>
                  <th className="px-4 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {[...months].reverse().map(m => (
                  <tr key={m.month} className={`border-b border-zinc-100 dark:border-zinc-800/50 ${!m.is_complete ? "bg-amber-50/30 dark:bg-amber-950/10" : ""}`}>
                    <td className="px-4 py-2.5 text-zinc-700 dark:text-zinc-300">
                      {monthLabel(m.month)}
                      {!m.is_complete && <span className="ml-1 text-[10px] text-amber-500">({m.days}d)</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                      {fmtShort(m.recurring_revenue_cents)}
                      <span className="ml-1 text-[10px] text-zinc-400">({m.recurring_count})</span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-blue-600 dark:text-blue-400">
                      {fmtShort(m.new_subscription_revenue_cents)}
                      <span className="ml-1 text-[10px] text-zinc-400">({m.new_subscription_count})</span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium text-zinc-900 dark:text-zinc-100">
                      {fmtShort(m.mrr_cents)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-red-600 dark:text-red-400">
                      {m.churn_cents > 0 ? fmtShort(m.churn_cents) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {m.churn_pct > 0 ? (
                        <span className={m.churn_pct > 10 ? "text-red-600 font-medium" : m.churn_pct > 5 ? "text-amber-600" : "text-zinc-500"}>
                          {m.churn_pct.toFixed(1)}%
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-violet-600 dark:text-violet-400">
                      {m.one_time_revenue_cents > 0 ? fmtShort(m.one_time_revenue_cents) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-zinc-500">
                      {m.subscription_rate > 0 ? `${m.subscription_rate.toFixed(0)}%` : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium text-zinc-900 dark:text-zinc-100">
                      {fmtShort(m.total_revenue_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs font-medium uppercase text-zinc-400">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${color}`}>{value}</p>
      <p className="mt-0.5 text-[10px] text-zinc-500">{sub}</p>
    </div>
  );
}

/** SVG line chart for churn trend */
function ChurnChart({ data }: { data: MonthData[] }) {
  const W = 800;
  const H = 200;
  const PAD = { top: 20, right: 20, bottom: 30, left: 50 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const maxChurn = Math.max(...data.map(d => d.churn_pct), 1);
  const yMax = Math.ceil(maxChurn / 5) * 5; // Round up to nearest 5

  const points = data.map((d, i) => {
    const x = PAD.left + (i / (data.length - 1)) * plotW;
    const y = PAD.top + plotH - (d.churn_pct / yMax) * plotH;
    return { x, y, data: d };
  });

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const areaPath = linePath + ` L ${points[points.length - 1].x} ${PAD.top + plotH} L ${points[0].x} ${PAD.top + plotH} Z`;

  const monthLabel = (m: string) => {
    const [y, mo] = m.split("-").map(Number);
    return new Date(y, mo - 1).toLocaleDateString("en-US", { month: "short" });
  };

  // Y axis ticks
  const yTicks = [];
  for (let i = 0; i <= yMax; i += Math.max(1, Math.floor(yMax / 4))) {
    yTicks.push(i);
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 250 }}>
      {/* Grid lines */}
      {yTicks.map(tick => {
        const y = PAD.top + plotH - (tick / yMax) * plotH;
        return (
          <g key={tick}>
            <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke="currentColor" className="text-zinc-100 dark:text-zinc-800" strokeWidth={1} />
            <text x={PAD.left - 8} y={y + 4} textAnchor="end" className="fill-zinc-400" fontSize={10}>{tick}%</text>
          </g>
        );
      })}

      {/* Area fill */}
      <path d={areaPath} className="fill-red-100/50 dark:fill-red-900/20" />

      {/* Line */}
      <path d={linePath} fill="none" stroke="currentColor" className="text-red-500" strokeWidth={2} strokeLinejoin="round" />

      {/* Points */}
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={4} className="fill-red-500" />
          <text x={p.x} y={p.y - 10} textAnchor="middle" className="fill-red-600 dark:fill-red-400" fontSize={10} fontWeight={600}>
            {p.data.churn_pct.toFixed(1)}%
          </text>
        </g>
      ))}

      {/* X axis labels */}
      {points.map((p, i) => (
        <text key={i} x={p.x} y={H - 5} textAnchor="middle" className="fill-zinc-400" fontSize={10}>
          {monthLabel(p.data.month)}
        </text>
      ))}
    </svg>
  );
}
