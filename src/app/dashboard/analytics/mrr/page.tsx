"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface DayData {
  date: string;
  static_count: number;
  static_revenue: number;
  expected_count: number;
  expected_revenue: number;
  collected_count: number;
  collected_revenue: number;
  failed_count: number;
  cancelled_count: number;
  dunning_count: number;
  dunning_revenue: number;
  dunning_collected_count: number;
  dunning_collected_revenue: number;
  dunning_failed_count: number;
  paused_count: number;
  paused_revenue: number;
  changes: Record<string, number>;
}

interface MRRData {
  daily: DayData[];
  totals: {
    static_revenue: number;
    static_count: number;
    expected_revenue: number;
    expected_count: number;
    collected_revenue: number;
    collected_count: number;
    failed_count: number;
    cancelled_count: number;
    dunning_revenue: number;
    dunning_count: number;
    dunning_collected_revenue: number;
    dunning_collected_count: number;
    dunning_failed_count: number;
    paused_revenue: number;
    paused_count: number;
  };
  changes: Record<string, number>;
}

function fmt(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtShort(cents: number): string {
  if (Math.abs(cents) >= 100000) return "$" + (cents / 100000).toFixed(1) + "K";
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function pct(a: number, b: number): string {
  if (b === 0) return "—";
  return Math.round((a / b) * 100) + "%";
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDate(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  return WEEKDAYS[d.getDay()] + " " + (d.getMonth() + 1) + "/" + d.getDate();
}

const CHANGE_LABELS: Record<string, string> = {
  new_subscription: "New subscriptions",
  cancellation: "Cancellations",
  pause: "Pauses",
  resume: "Resumes",
  item_change: "Item changes",
  date_change_out: "Date changes (out)",
  date_change_in: "Date changes (in)",
  interval_change: "Interval changes",
  billing_success: "Collected",
  billing_failure: "Failed",
  dunning_recovery: "Dunning recoveries",
  reactivation: "Reactivations",
};

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 overflow-hidden">
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums truncate ${color || "text-zinc-900 dark:text-zinc-100"}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-zinc-400 truncate">{sub}</p>}
    </div>
  );
}

export default function MRRDashboard() {
  const workspace = useWorkspace();
  const [data, setData] = useState<MRRData | null>(null);
  const [loading, setLoading] = useState(true);
  // Default: today (Central time) through 14 days out
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const defaultEnd = new Date(Date.now() + 14 * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const [startDate, setStartDate] = useState(todayStr);
  const [endDate, setEndDate] = useState(defaultEnd);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/workspaces/${workspace.id}/analytics/mrr?start=${startDate}&end=${endDate}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [workspace.id, startDate, endDate]);

  if (loading || !data) {
    return (
      <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
        <p className="text-sm text-zinc-400">Loading MRR forecast...</p>
      </div>
    );
  }

  const t = data.totals;
  const retentionRate = t.static_revenue > 0 ? (t.expected_revenue / t.static_revenue) * 100 : 0;
  const collectionRate = t.expected_revenue > 0 ? (t.collected_revenue / t.expected_revenue) * 100 : 0;

  // Group changes for display
  const changeEntries = Object.entries(data.changes)
    .filter(([, v]) => v !== 0)
    .sort((a, b) => a[1] - b[1]); // negatives first

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">MRR Forecast</h1>
          <p className="mt-1 text-sm text-zinc-500">Expected vs actual recurring revenue</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          />
          <span className="text-sm text-zinc-400">to</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          />
        </div>
      </div>

      {/* Summary Cards */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Static Forecast" value={fmt(t.static_revenue)} sub={`${t.static_count} subs in window`} />
        <StatCard label="Expected" value={fmt(t.expected_revenue)}
          sub={`${t.expected_count} subs · ${retentionRate.toFixed(0)}% retention`}
          color={retentionRate < 90 ? "text-amber-600" : "text-zinc-900 dark:text-zinc-100"} />
        <StatCard label="Collected" value={fmt(t.collected_revenue)}
          sub={`${t.collected_count} orders`}
          color="text-emerald-600 dark:text-emerald-400" />
        <StatCard label="Failed" value={String(t.failed_count)}
          sub={`${t.cancelled_count} cancelled`}
          color={t.failed_count > 0 ? "text-red-600" : "text-zinc-900 dark:text-zinc-100"} />
        <StatCard label="Dunning" value={fmt(t.dunning_revenue)}
          sub={`${t.dunning_count} retries · ${t.dunning_collected_count} recovered`}
          color="text-amber-600 dark:text-amber-400" />
        <StatCard label="Paused" value={fmt(t.paused_revenue)}
          sub={`${t.paused_count} subs pending resume`} />
      </div>

      {/* Changes Breakdown */}
      {changeEntries.length > 0 && (
        <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Forecast Changes</h2>
          <div className="space-y-1.5">
            {changeEntries.map(([type, delta]) => (
              <div key={type} className="flex items-center justify-between text-sm">
                <span className="text-zinc-600 dark:text-zinc-400">{CHANGE_LABELS[type] || type}</span>
                <span className={`tabular-nums font-medium ${delta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                  {delta >= 0 ? "+" : ""}{fmt(delta)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Daily Table */}
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Daily Forecast</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:border-zinc-800">
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2 text-right">Static</th>
                <th className="px-4 py-2 text-right">Expected</th>
                <th className="px-4 py-2 text-right">Collected</th>
                <th className="px-4 py-2 text-right">Failed</th>
                <th className="px-4 py-2 text-right">Cancelled</th>
                <th className="px-4 py-2 text-right">Dunning</th>
                <th className="px-4 py-2 text-right">Dunning Recovered</th>
              </tr>
            </thead>
            <tbody>
              {data.daily.map((d) => {
                const isToday = d.date === todayStr;
                const isPast = d.date < new Date().toISOString().slice(0, 10);
                return (
                  <tr key={d.date} className={`border-b border-zinc-50 dark:border-zinc-800/50 ${isToday ? "bg-indigo-50/50 dark:bg-indigo-950/20" : ""}`}>
                    <td className="px-4 py-2">
                      <span className={`font-medium ${isToday ? "text-indigo-600 dark:text-indigo-400" : "text-zinc-700 dark:text-zinc-300"}`}>
                        {formatDate(d.date)}
                      </span>
                      {isToday && <span className="ml-1.5 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300">Today</span>}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                      {fmtShort(d.static_revenue)}
                      <span className="ml-1 text-[10px] text-zinc-400">({d.static_count})</span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                      {fmtShort(d.expected_revenue)}
                      <span className="ml-1 text-[10px] text-zinc-400">({d.expected_count})</span>
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums ${d.collected_count > 0 ? "font-medium text-emerald-600 dark:text-emerald-400" : "text-zinc-400"}`}>
                      {d.collected_count > 0 ? fmtShort(d.collected_revenue) : "—"}
                      {d.collected_count > 0 && <span className="ml-1 text-[10px]">({d.collected_count})</span>}
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums ${d.failed_count > 0 ? "font-medium text-red-600 dark:text-red-400" : "text-zinc-400"}`}>
                      {d.failed_count > 0 ? d.failed_count : "—"}
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums ${d.cancelled_count > 0 ? "text-red-500" : "text-zinc-400"}`}>
                      {d.cancelled_count > 0 ? d.cancelled_count : "—"}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-amber-600 dark:text-amber-400">
                      {d.dunning_count > 0 ? (
                        <>
                          {fmtShort(d.dunning_revenue)}
                          <span className="ml-1 text-[10px]">({d.dunning_count})</span>
                        </>
                      ) : "—"}
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums ${d.dunning_collected_count > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-400"}`}>
                      {d.dunning_collected_count > 0 ? (
                        <>
                          {fmtShort(d.dunning_collected_revenue)}
                          <span className="ml-1 text-[10px]">({d.dunning_collected_count})</span>
                        </>
                      ) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {/* Totals row */}
            <tfoot>
              <tr className="border-t-2 border-zinc-200 bg-zinc-50/50 font-medium dark:border-zinc-700 dark:bg-zinc-800/50">
                <td className="px-4 py-2 text-zinc-900 dark:text-zinc-100">Total</td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  {fmt(t.static_revenue)} <span className="text-[10px] text-zinc-400">({t.static_count})</span>
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                  {fmt(t.expected_revenue)} <span className="text-[10px] text-zinc-400">({t.expected_count})</span>
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                  {t.collected_count > 0 ? fmt(t.collected_revenue) : "—"}
                  {t.collected_count > 0 && <span className="ml-1 text-[10px]">({t.collected_count})</span>}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-red-600">{t.failed_count || "—"}</td>
                <td className="px-4 py-2 text-right tabular-nums text-red-500">{t.cancelled_count || "—"}</td>
                <td className="px-4 py-2 text-right tabular-nums text-amber-600 dark:text-amber-400">
                  {fmt(t.dunning_revenue)} <span className="text-[10px]">({t.dunning_count})</span>
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                  {t.dunning_collected_count > 0 ? fmt(t.dunning_collected_revenue) : "—"}
                  {t.dunning_collected_count > 0 && <span className="ml-1 text-[10px]">({t.dunning_collected_count})</span>}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Trendlines placeholder — will populate over time */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Collection Rate</h2>
          <p className="text-xs text-zinc-400 mb-3">Actual collected / Expected (how much are we billing?)</p>
          {t.expected_revenue > 0 ? (
            <div className="flex items-end gap-2">
              <span className="text-3xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{collectionRate.toFixed(1)}%</span>
              <span className="mb-1 text-sm text-zinc-400">{fmt(t.collected_revenue)} of {fmt(t.expected_revenue)}</span>
            </div>
          ) : (
            <p className="text-sm text-zinc-400">No data yet — trendline builds as billing events come in</p>
          )}
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Retention Rate</h2>
          <p className="text-xs text-zinc-400 mb-3">Expected / Static forecast (how much survived cancels/pauses/changes?)</p>
          {t.static_revenue > 0 ? (
            <div className="flex items-end gap-2">
              <span className={`text-3xl font-bold tabular-nums ${retentionRate >= 90 ? "text-emerald-600 dark:text-emerald-400" : retentionRate >= 75 ? "text-amber-600" : "text-red-600"}`}>
                {retentionRate.toFixed(1)}%
              </span>
              <span className="mb-1 text-sm text-zinc-400">{fmt(t.expected_revenue)} of {fmt(t.static_revenue)}</span>
            </div>
          ) : (
            <p className="text-sm text-zinc-400">No data yet — trendline builds as events come in</p>
          )}
        </div>
      </div>
    </div>
  );
}
