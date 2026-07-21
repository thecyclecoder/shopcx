"use client";

// Pipeline-health dashboard — Mario's supervisor telemetry surface (mario-reactive-box-agent Phase 4).
// Ada watches the MarioAccuracyCard for trigger-accuracy drift; the CEO watches the same card via her
// approvals inbox when accuracy_pct drops below MARIO_ACCURACY_ALARM_PCT (default 60).

import { useEffect, useState, useCallback } from "react";
import { errText } from "@/lib/error-text";
import { useWorkspace } from "@/lib/workspace-context";

interface MarioAccuracyStats {
  window_days: number;
  fired_count: number;
  trigger_accurate_count: number;
  trigger_inaccurate_count: number;
  accuracy_pct: number | null;
}

interface MarioWidenedRow {
  id: string;
  from_event: string;
  to_event: string;
  sla_ms: number;
  last_widened_at: string | null;
  last_widened_reason: string | null;
}

interface AccuracyResponse {
  stats: MarioAccuracyStats;
  widened: MarioWidenedRow[];
  alarm_pct: number;
}

function formatMs(ms: number): string {
  if (ms >= 3600000) return `${(ms / 3600000).toFixed(1)}h`;
  if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function PipelineHealthPage() {
  const workspace = useWorkspace();
  const [data, setData] = useState<AccuracyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyRow, setBusyRow] = useState<string | null>(null);

  const fetchAccuracy = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/roadmap/mario/accuracy?workspace_id=${workspace.id}`);
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const json = (await res.json()) as AccuracyResponse;
      setData(json);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [workspace.id]);

  useEffect(() => {
    fetchAccuracy();
  }, [fetchAccuracy]);

  const revertRow = async (row: MarioWidenedRow) => {
    setBusyRow(row.id);
    try {
      const res = await fetch(`/api/roadmap/mario/threshold/revert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspace.id,
          from_event: row.from_event,
          to_event: row.to_event,
        }),
      });
      if (!res.ok) throw new Error(`revert failed: ${res.status}`);
      await fetchAccuracy();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyRow(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Pipeline health</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Mario's stall-detector supervisor telemetry — trigger accuracy over the last {data?.stats.window_days ?? 7} days and every widened threshold row Mario self-tuned.
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      {/* MarioAccuracyCard — Phase 4 surface for Ada. Renders fired_count / trigger_accurate_count /
          accuracy_pct + a table of every last_widened_at row with a Revert button. */}
      <div data-testid="mario-accuracy-card" className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Mario — trigger accuracy</h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Reactive stall detector · alarm at &lt; {data?.alarm_pct ?? 60}% accuracy → escalates to Ada
            </p>
          </div>
          <button
            onClick={fetchAccuracy}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Refresh
          </button>
        </div>

        {loading && !data ? (
          <div className="py-8 text-center text-sm text-zinc-500">Loading…</div>
        ) : data ? (
          <>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <div className="text-xs uppercase text-zinc-400">Fired</div>
                <div className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{data.stats.fired_count}</div>
              </div>
              <div>
                <div className="text-xs uppercase text-zinc-400">Accurate</div>
                <div className="mt-1 text-2xl font-semibold text-emerald-700 dark:text-emerald-400">{data.stats.trigger_accurate_count}</div>
                <div className="text-xs text-zinc-400">of {data.stats.trigger_accurate_count + data.stats.trigger_inaccurate_count} decided</div>
              </div>
              <div>
                <div className="text-xs uppercase text-zinc-400">Accuracy</div>
                <div
                  className={
                    "mt-1 text-2xl font-semibold " +
                    (data.stats.accuracy_pct == null
                      ? "text-zinc-400"
                      : data.stats.accuracy_pct < data.alarm_pct
                        ? "text-red-600 dark:text-red-400"
                        : "text-emerald-700 dark:text-emerald-400")
                  }
                >
                  {data.stats.accuracy_pct == null ? "—" : `${data.stats.accuracy_pct}%`}
                </div>
              </div>
            </div>

            <div className="mt-6">
              <h3 className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">Widened thresholds ({data.widened.length})</h3>
              {data.widened.length === 0 ? (
                <div className="rounded-md border border-dashed border-zinc-200 py-4 text-center text-xs text-zinc-500 dark:border-zinc-700">
                  No widened rows — every mario_thresholds row is at its seeded default.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase text-zinc-400 dark:border-zinc-800">
                        <th className="px-3 py-2">Pair</th>
                        <th className="px-3 py-2">SLA</th>
                        <th className="px-3 py-2">Widened</th>
                        <th className="px-3 py-2">Reason</th>
                        <th className="px-3 py-2 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.widened.map((w) => (
                        <tr key={w.id} className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800">
                          <td className="px-3 py-2 font-mono text-xs">
                            {w.from_event} → {w.to_event}
                          </td>
                          <td className="px-3 py-2 tabular-nums">{formatMs(w.sla_ms)}</td>
                          <td className="px-3 py-2 text-zinc-500">{formatWhen(w.last_widened_at)}</td>
                          <td className="px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400">
                            {w.last_widened_reason ?? "—"}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button
                              onClick={() => revertRow(w)}
                              disabled={busyRow === w.id}
                              className="rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                            >
                              {busyRow === w.id ? "Reverting…" : "Revert"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
