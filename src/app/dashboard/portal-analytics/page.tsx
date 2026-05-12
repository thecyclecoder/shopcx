"use client";

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Summary {
  sessions: number;
  cancel_flow_starts: number;
  saves: number;
  cancellations: number;
  abandons: number;
  save_rate: number;
  top_remedy: { type: string; rate: number } | null;
}

interface PortalAction {
  action: string;
  count: number;
}

interface CancelReason {
  reason: string;
  type: string;
  count: number;
}

interface RemedyPerf {
  type: string;
  shown: number;
  accepted: number;
  passed_over: number;
  rejected: number;
  acceptance_rate: number;
}

interface CancelFunnel {
  started: number;
  shown_remedies: number;
  saved: number;
  cancelled: number;
  abandoned: number;
}

interface ErrorLogEntry {
  timestamp: string;
  customer: string;
  customer_id: string;
  route: string;
  error: string;
  message: string | null;
  appstle_details: string | null;
  request_payload: Record<string, unknown> | null;
}

interface AnalyticsData {
  summary: Summary;
  portal_actions: PortalAction[];
  cancel_reasons: CancelReason[];
  remedy_performance: RemedyPerf[];
  cancel_funnel: CancelFunnel;
  error_log: ErrorLogEntry[];
}

const DATE_RANGES = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "all", label: "All time" },
];

const REMEDY_LABELS: Record<string, string> = {
  coupon: "Coupon / Discount",
  pause: "Pause",
  skip: "Skip Order",
  frequency_change: "Frequency Change",
  free_product: "Free Product",
  line_item_modifier: "Item Change",
};

const REASON_LABELS: Record<string, string> = {
  too_expensive: "Too expensive",
  too_much_product: "Too much product",
  not_seeing_results: "Not seeing results",
  reached_goals: "Reached goals",
  just_need_a_break: "Need a break",
  something_else: "Something else",
  shipping: "Shipping issues",
  taste_texture: "Taste/texture",
  health_change: "Health change",
};

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs font-medium text-zinc-400 uppercase tracking-wider">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${color || "text-zinc-900 dark:text-zinc-100"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-400">{sub}</div>}
    </div>
  );
}

function FunnelBar({ label, count, max, color }: { label: string; count: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  const width = max > 0 ? Math.max(2, (count / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-36 text-sm text-zinc-600 dark:text-zinc-400 truncate">{label}</div>
      <div className="flex-1 h-7 bg-zinc-100 dark:bg-zinc-800 rounded-lg overflow-hidden">
        <div className={`h-full rounded-lg ${color} transition-all duration-500`} style={{ width: `${width}%` }} />
      </div>
      <div className="w-16 text-right text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {count} <span className="text-zinc-400 text-xs">({pct}%)</span>
      </div>
    </div>
  );
}

function VerticalFunnel({ steps }: { steps: { label: string; count: number; color: string }[] }) {
  const max = steps[0]?.count || 1;
  return (
    <div className="space-y-1">
      {steps.map((step, i) => {
        const pct = max > 0 ? Math.round((step.count / max) * 100) : 0;
        const width = max > 0 ? Math.max(8, (step.count / max) * 100) : 8;
        return (
          <div key={i} className="flex flex-col items-center">
            <div
              className={`${step.color} rounded-lg py-3 px-4 text-center text-white font-medium text-sm transition-all duration-500`}
              style={{ width: `${width}%`, minWidth: "120px" }}
            >
              {step.label}: {step.count} {pct < 100 && pct > 0 ? `(${pct}%)` : ""}
            </div>
            {i < steps.length - 1 && (
              <div className="text-zinc-300 dark:text-zinc-600 text-lg leading-none">&#9660;</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function PortalAnalyticsPage() {
  const workspace = useWorkspace();
  const [range, setRange] = useState("7d");
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/portal-analytics?range=${range}`);
      if (res.ok) setData(await res.json());
    } catch {}
    setLoading(false);
  }, [workspace.id, range]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const s = data?.summary;

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-6 gap-3">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Portal Analytics</h1>
          <p className="mt-1 text-sm text-zinc-500">Customer self-service performance and retention insights</p>
        </div>
        <div className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
          {DATE_RANGES.map(r => (
            <button
              key={r.value}
              onClick={() => setRange(r.value)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                range === r.value
                  ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[1,2,3].map(i => <div key={i} className="h-24 rounded-xl bg-zinc-100 dark:bg-zinc-800 animate-pulse" />)}
        </div>
      ) : !data ? (
        <div className="text-center py-12 text-sm text-zinc-400">Failed to load analytics.</div>
      ) : (
        <div className="space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard label="Portal Sessions" value={s?.sessions || 0} />
            <StatCard label="Cancel Flows Started" value={s?.cancel_flow_starts || 0} />
            <StatCard
              label="Save Rate"
              value={`${s?.save_rate || 0}%`}
              color={(s?.save_rate || 0) >= 50 ? "text-emerald-600" : (s?.save_rate || 0) >= 25 ? "text-amber-600" : "text-red-600"}
              sub={`${s?.saves || 0} saved / ${s?.cancellations || 0} cancelled`}
            />
            <StatCard
              label="Top Remedy"
              value={s?.top_remedy ? REMEDY_LABELS[s.top_remedy.type] || s.top_remedy.type : "—"}
              sub={s?.top_remedy ? `${s.top_remedy.rate}% acceptance` : "Not enough data"}
            />
          </div>

          {/* Two-column layout */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Portal Actions Distribution */}
            <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Portal Actions</h3>
              {data.portal_actions.length === 0 ? (
                <p className="text-sm text-zinc-400 py-4 text-center">No portal activity in this period</p>
              ) : (
                <div className="space-y-2">
                  {data.portal_actions.map(a => (
                    <FunnelBar
                      key={a.action}
                      label={a.action}
                      count={a.count}
                      max={data.portal_actions[0]?.count || 1}
                      color={a.action === "Started cancel flow" ? "bg-red-400" : a.action === "Saved by remedy" ? "bg-emerald-500" : "bg-indigo-400"}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Cancel Flow Funnel */}
            <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Cancel Flow Funnel</h3>
              {data.cancel_funnel.started === 0 ? (
                <p className="text-sm text-zinc-400 py-4 text-center">No cancel flows in this period</p>
              ) : (
                <VerticalFunnel steps={[
                  { label: "Started", count: data.cancel_funnel.started, color: "bg-zinc-500" },
                  { label: "Saved", count: data.cancel_funnel.saved, color: "bg-emerald-500" },
                  { label: "Cancelled", count: data.cancel_funnel.cancelled, color: "bg-red-400" },
                  ...(data.cancel_funnel.abandoned > 0
                    ? [{ label: "Abandoned", count: data.cancel_funnel.abandoned, color: "bg-zinc-400" }]
                    : []),
                ]} />
              )}
            </div>
          </div>

          {/* Cancel Reasons */}
          <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Cancel Reasons</h3>
            {data.cancel_reasons.length === 0 ? (
              <p className="text-sm text-zinc-400 py-4 text-center">No cancel reasons recorded</p>
            ) : (
              <div className="space-y-2">
                {data.cancel_reasons.map(r => (
                  <FunnelBar
                    key={r.reason}
                    label={REASON_LABELS[r.reason] || r.reason}
                    count={r.count}
                    max={data.cancel_reasons[0]?.count || 1}
                    color={r.type === "ai_conversation" ? "bg-violet-400" : "bg-cyan-400"}
                  />
                ))}
              </div>
            )}
            <div className="mt-3 flex gap-4 text-xs text-zinc-400">
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-cyan-400" /> Remedies</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-violet-400" /> AI Chat</span>
            </div>
          </div>

          {/* Remedy Performance */}
          <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Remedy Performance</h3>
            {data.remedy_performance.length === 0 ? (
              <p className="text-sm text-zinc-400 py-4 text-center">No remedy data yet</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-zinc-400 uppercase tracking-wider border-b border-zinc-100 dark:border-zinc-800">
                      <th className="pb-2 pr-4">Remedy</th>
                      <th className="pb-2 pr-4 text-right">Shown</th>
                      <th className="pb-2 pr-4 text-right">Accepted</th>
                      <th className="pb-2 pr-4 text-right">Passed Over</th>
                      <th className="pb-2 pr-4 text-right">Rejected</th>
                      <th className="pb-2 text-right">Rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
                    {data.remedy_performance.map(r => (
                      <tr key={r.type}>
                        <td className="py-2.5 pr-4 font-medium text-zinc-700 dark:text-zinc-300">
                          {REMEDY_LABELS[r.type] || r.type}
                        </td>
                        <td className="py-2.5 pr-4 text-right text-zinc-500">{r.shown}</td>
                        <td className="py-2.5 pr-4 text-right text-emerald-600 font-medium">{r.accepted}</td>
                        <td className="py-2.5 pr-4 text-right text-zinc-400">{r.passed_over}</td>
                        <td className="py-2.5 pr-4 text-right text-red-400">{r.rejected}</td>
                        <td className="py-2.5 text-right">
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            r.acceptance_rate >= 50 ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                            : r.acceptance_rate >= 25 ? "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                            : "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                          }`}>
                            {r.acceptance_rate}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Error Log ── */}
      {data && data.error_log && data.error_log.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-white p-5 shadow-sm dark:border-red-800/50 dark:bg-zinc-900">
          <h3 className="text-sm font-semibold text-red-600 dark:text-red-400 mb-4">Error Log ({data.error_log.length})</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-400 uppercase tracking-wider border-b border-zinc-100 dark:border-zinc-800">
                  <th className="pb-2 pr-4">Time</th>
                  <th className="pb-2 pr-4">Customer</th>
                  <th className="pb-2 pr-4">Route</th>
                  <th className="pb-2 pr-4">Error</th>
                  <th className="pb-2">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
                {data.error_log.map((e, i) => (
                  <tr key={i} className="group">
                    <td className="py-2.5 pr-4 text-zinc-400 whitespace-nowrap text-xs">
                      {new Date(e.timestamp).toLocaleString()}
                    </td>
                    <td className="py-2.5 pr-4 text-zinc-700 dark:text-zinc-300">
                      <a href={`/dashboard/customers/${e.customer_id}`} className="hover:text-indigo-600 dark:hover:text-indigo-400">
                        {e.customer}
                      </a>
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-zinc-500">{e.route}</td>
                    <td className="py-2.5 pr-4">
                      <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
                        {e.error}
                      </span>
                    </td>
                    <td className="py-2.5 text-xs text-zinc-400 max-w-xs">
                      {e.message && <div>{e.message}</div>}
                      {e.appstle_details && <div className="mt-0.5 font-mono text-red-400 truncate">{typeof e.appstle_details === 'string' ? e.appstle_details.substring(0, 200) : JSON.stringify(e.appstle_details).substring(0, 200)}</div>}
                      {e.request_payload && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-zinc-400 hover:text-zinc-600">Payload</summary>
                          <pre className="mt-1 text-xs bg-zinc-50 dark:bg-zinc-800 p-2 rounded overflow-x-auto max-h-32">{JSON.stringify(e.request_payload, null, 2)}</pre>
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
