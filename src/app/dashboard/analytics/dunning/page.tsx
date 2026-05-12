"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface CycleStats {
  active: number;
  retrying: number;
  skipped: number;
  recovered: number;
  exhausted: number;
  terminal: number;
  total: number;
}

interface ErrorCodeRow {
  error_code: string;
  error_message: string | null;
  count: number;
  is_terminal: boolean;
}

interface DailyData {
  date: string;
  failures: number;
}

interface RecentFailure {
  id: string;
  shopify_contract_id: string;
  error_code: string | null;
  error_message: string | null;
  attempt_type: string;
  succeeded: boolean;
  payment_method_last4: string | null;
  created_at: string;
}

interface TerminalCancel {
  id: string;
  shopify_contract_id: string;
  customer_id: string | null;
  terminal_error_code: string;
  created_at: string;
}

interface AnalyticsData {
  cycleStats: CycleStats;
  errorCodeDistribution: ErrorCodeRow[];
  dailyData: DailyData[];
  terminalCancels: TerminalCancel[];
  recentFailures: RecentFailure[];
  recoveryRate: number;
  totalInitialFailures: number;
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${color || ""}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-zinc-400">{sub}</p>}
    </div>
  );
}

export default function DunningAnalyticsPage() {
  const workspace = useWorkspace();
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/workspaces/${workspace.id}/analytics/dunning`);
      if (cancelled) return;
      if (res.ok) setData(await res.json());
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [workspace.id]);

  if (loading || !data) {
    return (
      <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
        <p className="text-sm text-zinc-400">Loading dunning analytics...</p>
      </div>
    );
  }

  const { cycleStats, errorCodeDistribution, dailyData, terminalCancels, recentFailures, recoveryRate, totalInitialFailures } = data;
  const terminalErrors = errorCodeDistribution.filter(e => e.is_terminal);
  const retryableErrors = errorCodeDistribution.filter(e => !e.is_terminal);
  const terminalFailureCount = terminalErrors.reduce((s, e) => s + e.count, 0);
  const retryableFailureCount = retryableErrors.reduce((s, e) => s + e.count, 0);

  // Chart dimensions
  const chartW = 720;
  const chartH = 160;
  const padL = 40;
  const padR = 10;
  const padT = 10;
  const padB = 25;
  const innerW = chartW - padL - padR;
  const innerH = chartH - padT - padB;

  const maxFailures = Math.max(...dailyData.map(d => d.failures), 1);
  const yTicks = [0, Math.ceil(maxFailures / 2), maxFailures];

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Dunning Analytics</h1>
        <p className="mt-1 text-sm text-zinc-500">Payment failure recovery performance over the last 90 days.</p>
      </div>

      {/* Summary cards */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Active" value={String(cycleStats.active)} sub="Currently in card rotation" color="text-amber-600" />
        <StatCard label="Retrying" value={String(cycleStats.retrying)} sub="Payday retry scheduled" color="text-amber-500" />
        <StatCard label="Recovered" value={String(cycleStats.recovered)} sub={`${recoveryRate}% recovery rate`} color="text-emerald-600" />
        <StatCard label="Exhausted" value={String(cycleStats.exhausted)} sub="All retries failed" color="text-red-600" />
        <StatCard label="Terminal" value={String(cycleStats.terminal)} sub="Cancelled (bad card)" color="text-red-700" />
        <StatCard label="Failures (90d)" value={String(totalInitialFailures)} sub={`${terminalFailureCount} terminal`} />
      </div>

      {/* Daily failures chart */}
      {dailyData.length > 1 && (
        <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Daily Billing Failures (30 days)</h3>
          <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full" preserveAspectRatio="xMidYMid meet">
            {/* Grid lines */}
            {yTicks.map(t => {
              const y = padT + innerH - (t / maxFailures) * innerH;
              return (
                <g key={t}>
                  <line x1={padL} x2={chartW - padR} y1={y} y2={y} stroke="#e4e4e7" strokeWidth={0.5} />
                  <text x={padL - 4} y={y + 3} textAnchor="end" className="fill-zinc-400" fontSize={9}>{t}</text>
                </g>
              );
            })}
            {/* Bars */}
            {dailyData.map((d, i) => {
              const barW = Math.max(innerW / dailyData.length - 2, 2);
              const x = padL + (i / dailyData.length) * innerW + 1;
              const h = (d.failures / maxFailures) * innerH;
              const y = padT + innerH - h;
              return (
                <g key={d.date}>
                  <rect x={x} y={y} width={barW} height={h} rx={1} className="fill-red-400/80" />
                  {/* Date labels — every 7th */}
                  {i % 7 === 0 && (
                    <text x={x + barW / 2} y={chartH - 2} textAnchor="middle" className="fill-zinc-400" fontSize={8}>
                      {new Date(d.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {/* Error code distribution */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Terminal errors */}
        <div className="rounded-lg border border-red-200 bg-white p-5 dark:border-red-900/50 dark:bg-zinc-900">
          <h3 className="mb-3 text-sm font-semibold text-red-700 dark:text-red-400">
            Terminal Errors
            <span className="ml-2 text-xs font-normal text-zinc-400">Skip retries, cancel immediately</span>
          </h3>
          {terminalErrors.length === 0 ? (
            <p className="text-xs text-zinc-400">No terminal errors configured</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase tracking-wider text-zinc-400 dark:border-zinc-800">
                  <th className="pb-2 pr-3">Code</th>
                  <th className="pb-2 text-right">Count (90d)</th>
                </tr>
              </thead>
              <tbody>
                {terminalErrors.map(e => (
                  <tr key={e.error_code} className="border-b border-zinc-50 dark:border-zinc-800/50">
                    <td className="py-1.5 pr-3">
                      <code className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-mono text-red-700 dark:bg-red-900/30 dark:text-red-400">{e.error_code}</code>
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-xs text-zinc-500">{e.count}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="text-xs font-semibold text-red-700 dark:text-red-400">
                  <td className="pt-2">Total</td>
                  <td className="pt-2 text-right tabular-nums">{terminalFailureCount}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        {/* Retryable errors */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Retryable Errors
            <span className="ml-2 text-xs font-normal text-zinc-400">Card rotation + payday retries</span>
          </h3>
          {retryableErrors.length === 0 ? (
            <p className="text-xs text-zinc-400">No retryable errors recorded</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase tracking-wider text-zinc-400 dark:border-zinc-800">
                  <th className="pb-2 pr-3">Code</th>
                  <th className="pb-2 text-right">Count (90d)</th>
                </tr>
              </thead>
              <tbody>
                {retryableErrors.map(e => (
                  <tr key={e.error_code} className="border-b border-zinc-50 dark:border-zinc-800/50">
                    <td className="py-1.5 pr-3">
                      <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-mono text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{e.error_code}</code>
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-xs text-zinc-500">{e.count}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                  <td className="pt-2">Total</td>
                  <td className="pt-2 text-right tabular-nums">{retryableFailureCount}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>

      {/* Terminal cancellations */}
      {terminalCancels.length > 0 && (
        <div className="mb-6 rounded-lg border border-red-200 bg-white p-5 dark:border-red-900/50 dark:bg-zinc-900">
          <h3 className="mb-3 text-sm font-semibold text-red-700 dark:text-red-400">
            Terminal Cancellations
            <span className="ml-2 text-xs font-normal text-zinc-400">Cancelled due to terminal billing error — will auto-recover if customer adds new card</span>
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase tracking-wider text-zinc-400 dark:border-zinc-800">
                  <th className="pb-2 pr-3">Contract</th>
                  <th className="pb-2 pr-3">Error Code</th>
                  <th className="pb-2 pr-3">Cancelled</th>
                </tr>
              </thead>
              <tbody>
                {terminalCancels.slice(0, 25).map(tc => (
                  <tr key={tc.id} className="border-b border-zinc-50 dark:border-zinc-800/50">
                    <td className="py-1.5 pr-3 text-xs tabular-nums text-zinc-500">{tc.shopify_contract_id}</td>
                    <td className="py-1.5 pr-3">
                      <code className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-mono text-red-700 dark:bg-red-900/30 dark:text-red-400">{tc.terminal_error_code}</code>
                    </td>
                    <td className="py-1.5 pr-3 text-xs text-zinc-400">
                      {new Date(tc.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent billing failures */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Recent Billing Failures (30 days)
          <span className="ml-2 text-xs font-normal text-zinc-400">Initial failures only</span>
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase tracking-wider text-zinc-400 dark:border-zinc-800">
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Contract</th>
                <th className="pb-2 pr-3">Error Code</th>
                <th className="pb-2 pr-3">Message</th>
                <th className="pb-2 pr-3">Card</th>
              </tr>
            </thead>
            <tbody>
              {recentFailures.slice(0, 50).map(f => {
                const terminalCode = errorCodeDistribution.find(e => e.error_code === f.error_code);
                return (
                  <tr key={f.id} className="border-b border-zinc-50 dark:border-zinc-800/50">
                    <td className="py-1.5 pr-3 text-xs tabular-nums text-zinc-400">
                      {new Date(f.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </td>
                    <td className="py-1.5 pr-3 text-xs tabular-nums text-zinc-500">{f.shopify_contract_id}</td>
                    <td className="py-1.5 pr-3">
                      {f.error_code ? (
                        <code className={`rounded px-1.5 py-0.5 text-xs font-mono ${
                          terminalCode?.is_terminal
                            ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                            : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                        }`}>{f.error_code}</code>
                      ) : (
                        <span className="text-xs text-zinc-400">—</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-xs text-zinc-500 max-w-[200px] truncate" title={f.error_message || ""}>
                      {f.error_message || "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-xs tabular-nums text-zinc-400">
                      {f.payment_method_last4 ? `****${f.payment_method_last4}` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
