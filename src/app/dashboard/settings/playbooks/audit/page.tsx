"use client";

/**
 * /dashboard/settings/playbooks/audit
 *
 * Existing-playbook audit surface (playbook-compiler-loop § Phase 2). Renders
 * one row per ACTIVE playbook with total runs (30d), escalation rate, low-
 * value-option share, and avg AI-turns-per-run — plus a Retire button that
 * flips `playbooks.is_active=false` and writes a `director_activity` row of
 * `kind='playbook_retired'` via `POST /api/workspaces/[id]/playbooks/retire`.
 *
 * Warn indicator: a red badge on any row whose 30-day escalation rate is
 * >= 30% — the "escalation-rate 30% threshold" the spec-test asserts on.
 */

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface AuditRow {
  id: string;
  name: string;
  total_runs: number;
  escalated_runs: number;
  escalation_rate: number;
  low_value_share: number;
  avg_turns: number;
}

// Warn on the 30-day escalation-rate ≥ 30% surface — the exact predicate the
// verification bullet cites ("On a playbook with escalation-rate >= 30% (30d)
// → expect a visual warn indicator on its row").
const WARN_ESCALATION_RATE = 0.30;

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export default function PlaybooksAuditPage() {
  const workspace = useWorkspace();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [retiring, setRetiring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/playbooks/audit`);
      if (res.ok) {
        const data = await res.json();
        setRows((data.rows || []) as AuditRow[]);
      } else {
        setError(`HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch_failed");
    }
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  const retire = async (id: string, name: string) => {
    if (!confirm(`Retire the "${name}" playbook? It will move to the Retired subsection and stop being offered to Sonnet.`)) return;
    setRetiring(id);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/playbooks/retire`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playbook_id: id }),
      });
      if (res.ok) await fetchRows();
      else setError(`Retire failed: HTTP ${res.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "retire_failed");
    }
    setRetiring(null);
  };

  return (
    <div className="mx-auto w-full max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Playbook Audit</h1>
        <p className="mt-1 text-sm text-zinc-500">
          30-day rollup per active playbook. High escalation-rate + high low-value share ={" "}
          candidate for retirement. Retiring a playbook flips it out of the Sonnet handler catalog.
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && <p className="text-sm text-zinc-400">Loading audit…</p>}

      {!loading && rows.length === 0 && (
        <p className="text-sm text-zinc-400">No active playbooks to audit.</p>
      )}

      {!loading && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-800">
            <thead className="bg-zinc-50 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-zinc-500 uppercase">Playbook</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-zinc-500 uppercase">Runs (30d)</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-zinc-500 uppercase">Escalation rate</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-zinc-500 uppercase">Low-value share</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-zinc-500 uppercase">Avg turns</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-zinc-500 uppercase">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 bg-white dark:divide-zinc-800 dark:bg-zinc-900">
              {rows.map((r) => {
                const warn = r.escalation_rate >= WARN_ESCALATION_RATE;
                return (
                  <tr key={r.id} data-warn={warn ? "1" : "0"}>
                    <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-100">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{r.name}</span>
                        {warn && (
                          <span
                            data-testid="warn-escalation-rate"
                            title={`Escalation rate ${pct(r.escalation_rate)} ≥ ${pct(WARN_ESCALATION_RATE)} (30d)`}
                            className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950 dark:text-red-300"
                          >
                            ⚠ high escalation
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right text-sm tabular-nums text-zinc-700 dark:text-zinc-300">{r.total_runs}</td>
                    <td className={`px-4 py-2 text-right text-sm tabular-nums ${warn ? "font-semibold text-red-600 dark:text-red-400" : "text-zinc-700 dark:text-zinc-300"}`}>
                      {pct(r.escalation_rate)}
                    </td>
                    <td className="px-4 py-2 text-right text-sm tabular-nums text-zinc-700 dark:text-zinc-300">{pct(r.low_value_share)}</td>
                    <td className="px-4 py-2 text-right text-sm tabular-nums text-zinc-700 dark:text-zinc-300">{r.avg_turns.toFixed(2)}</td>
                    <td className="px-4 py-2 text-right text-sm">
                      <button
                        onClick={() => retire(r.id, r.name)}
                        disabled={retiring === r.id}
                        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-red-950"
                      >
                        {retiring === r.id ? "Retiring…" : "Retire"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
