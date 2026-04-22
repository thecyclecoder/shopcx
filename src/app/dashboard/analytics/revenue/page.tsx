"use client";

import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface DaySnapshot {
  snapshot_date: string;
  recurring_count: number;
  recurring_revenue_cents: number;
  new_subscription_count: number;
  new_subscription_revenue_cents: number;
  one_time_count: number;
  one_time_revenue_cents: number;
  replacement_count: number;
  total_count: number;
  total_revenue_cents: number;
  shopify_count: number | null;
  shopify_mismatch: boolean;
}

function fmt(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtK(cents: number): string {
  if (cents >= 100000) return "$" + (cents / 100000).toFixed(1) + "K";
  return fmt(cents);
}

export default function RevenueDashboard() {
  const workspace = useWorkspace();
  const [snapshots, setSnapshots] = useState<DaySnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });

  const load = useCallback(async () => {
    setLoading(true);
    const [year, mo] = month.split("-").map(Number);
    const startDate = `${month}-01`;
    const endDate = new Date(year, mo, 0).toISOString().slice(0, 10); // last day of month

    const res = await fetch(
      `/api/workspaces/${workspace.id}/analytics/revenue?start=${startDate}&end=${endDate}`
    );
    if (res.ok) {
      const data = await res.json();
      setSnapshots(data.snapshots || []);
    }
    setLoading(false);
  }, [workspace.id, month]);

  useEffect(() => { load(); }, [load]);

  // Aggregates
  const recurring = snapshots.reduce((s, d) => s + d.recurring_revenue_cents, 0);
  const recurringCount = snapshots.reduce((s, d) => s + d.recurring_count, 0);
  const newSub = snapshots.reduce((s, d) => s + d.new_subscription_revenue_cents, 0);
  const newSubCount = snapshots.reduce((s, d) => s + d.new_subscription_count, 0);
  const oneTime = snapshots.reduce((s, d) => s + d.one_time_revenue_cents, 0);
  const oneTimeCount = snapshots.reduce((s, d) => s + d.one_time_count, 0);
  const totalRev = snapshots.reduce((s, d) => s + d.total_revenue_cents, 0);
  const totalCount = snapshots.reduce((s, d) => s + d.total_count, 0);
  const subRate = totalRev > 0 ? ((recurring + newSub) / totalRev * 100) : 0;
  const mismatches = snapshots.filter(d => d.shopify_mismatch);

  const monthLabel = new Date(month + "-01").toLocaleDateString("en-US", { month: "long", year: "numeric" });

  // Month navigation
  const prevMonth = () => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 2, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };
  const nextMonth = () => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Revenue</h1>
          <p className="mt-1 text-sm text-zinc-500">Daily order snapshots with Shopify validation.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={prevMonth} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800">&larr;</button>
          <span className="min-w-[140px] text-center text-sm font-medium text-zinc-700 dark:text-zinc-300">{monthLabel}</span>
          <button onClick={nextMonth} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800">&rarr;</button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-400">Loading...</p>
      ) : (
        <>
          {/* Summary cards */}
          <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Recurring Revenue" value={fmt(recurring)} sub={`${recurringCount} orders`} color="text-emerald-600 dark:text-emerald-400" />
            <StatCard label="New Subscriptions" value={fmt(newSub)} sub={`${newSubCount} orders`} color="text-blue-600 dark:text-blue-400" />
            <StatCard label="One-Time Sales" value={fmt(oneTime)} sub={`${oneTimeCount} orders`} color="text-violet-600 dark:text-violet-400" />
            <StatCard label="Total Revenue" value={fmt(totalRev)} sub={`${totalCount} orders · ${subRate.toFixed(0)}% sub rate`} color="text-zinc-900 dark:text-zinc-100" />
          </div>

          {/* Mismatch alert */}
          {mismatches.length > 0 && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
              {mismatches.length} day{mismatches.length !== 1 ? "s" : ""} with Shopify sync mismatch
            </div>
          )}

          {/* Daily table */}
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800">
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2 text-right">Recurring</th>
                  <th className="px-4 py-2 text-right">New Subs</th>
                  <th className="px-4 py-2 text-right">One-Time</th>
                  <th className="px-4 py-2 text-right">Total</th>
                  <th className="px-4 py-2 text-right">Orders</th>
                  <th className="px-4 py-2 text-right">Shopify</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-zinc-400">No data for this month.</td></tr>
                ) : (
                  snapshots.map(d => (
                    <tr key={d.snapshot_date} className={`border-b border-zinc-100 dark:border-zinc-800/50 ${d.shopify_mismatch ? "bg-amber-50/50 dark:bg-amber-950/20" : ""}`}>
                      <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                        {new Date(d.snapshot_date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {fmt(d.recurring_revenue_cents)}
                        <span className="ml-1 text-[10px] text-zinc-400">({d.recurring_count})</span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-blue-600 dark:text-blue-400">
                        {d.new_subscription_revenue_cents > 0 ? fmt(d.new_subscription_revenue_cents) : "—"}
                        {d.new_subscription_count > 0 && <span className="ml-1 text-[10px] text-zinc-400">({d.new_subscription_count})</span>}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-violet-600 dark:text-violet-400">
                        {d.one_time_revenue_cents > 0 ? fmt(d.one_time_revenue_cents) : "—"}
                        {d.one_time_count > 0 && <span className="ml-1 text-[10px] text-zinc-400">({d.one_time_count})</span>}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium text-zinc-900 dark:text-zinc-100">
                        {fmt(d.total_revenue_cents)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-zinc-500">{d.total_count}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {d.shopify_count != null ? (
                          <span className={d.shopify_mismatch ? "text-amber-600 dark:text-amber-400" : "text-zinc-400"}>
                            {d.shopify_count}
                            {d.shopify_mismatch && " ⚠"}
                          </span>
                        ) : (
                          <span className="text-zinc-300">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {snapshots.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-zinc-300 bg-zinc-50 font-medium dark:border-zinc-700 dark:bg-zinc-800/50">
                    <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">Total</td>
                    <td className="px-4 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{fmt(recurring)} <span className="text-[10px] text-zinc-400">({recurringCount})</span></td>
                    <td className="px-4 py-2 text-right tabular-nums text-blue-600 dark:text-blue-400">{fmt(newSub)} <span className="text-[10px] text-zinc-400">({newSubCount})</span></td>
                    <td className="px-4 py-2 text-right tabular-nums text-violet-600 dark:text-violet-400">{fmt(oneTime)} <span className="text-[10px] text-zinc-400">({oneTimeCount})</span></td>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-900 dark:text-zinc-100">{fmt(totalRev)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-500">{totalCount}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-400"></td>
                  </tr>
                </tfoot>
              )}
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
