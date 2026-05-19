"use client";

/**
 * Research & Heal panel for the ticket detail page.
 *
 * Surfaces:
 *  - the latest research run per recipe (findings + gaps)
 *  - prior heal_attempts (so already-healed gaps don't re-render an action button)
 *  - "Run recipe" buttons for available recipes
 *  - "Heal" buttons on each open gap (one-click — server-side re-verify,
 *    execute, re-verify, customer message, close)
 */

import { useCallback, useEffect, useState } from "react";

interface Finding {
  type: string;
  subject: string;
  evidence: Record<string, unknown>;
  severity: "info" | "low" | "medium" | "high";
}
interface Gap {
  gap_id: string;
  description: string;
  severity: "low" | "medium" | "high";
  proposed_heal?: {
    action_type: string;
    params: Record<string, unknown>;
    customer_message_template: string;
    customer_message_persona: "suzie" | "julie";
  };
}
interface ResearchRun {
  id: string;
  recipe_slug: string;
  recipe_version: number;
  ran_at: string;
  findings: Finding[];
  gaps: Gap[];
  triggered_by: string;
}
interface HealAttempt {
  id: string;
  gap_id: string;
  action_type: string;
  status: string;
  attempted_at: string;
  error: string | null;
  customer_message_sent: boolean;
}
interface AvailableRecipe {
  slug: string;
  description: string;
  version: number;
}

export default function ResearchPanel({ workspaceId, ticketId }: { workspaceId: string; ticketId: string }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<ResearchRun[]>([]);
  const [heals, setHeals] = useState<HealAttempt[]>([]);
  const [available, setAvailable] = useState<AvailableRecipe[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/tickets/${ticketId}/research`);
      if (r.ok) {
        const d = await r.json();
        setRuns(d.runs || []);
        setHeals(d.heals || []);
        setAvailable(d.available_recipes || []);
      }
    } finally { setLoading(false); }
  }, [workspaceId, ticketId]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  async function runRecipe(slug: string) {
    setBusy(`run:${slug}`);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/tickets/${ticketId}/research`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipes: [slug] }),
      });
      const d = await r.json();
      const res = d.results?.[0];
      setToast(res?.error ? `Error: ${res.error}` : `${slug}: ${res?.findings || 0} findings · ${res?.gaps || 0} gaps`);
      await load();
    } finally { setBusy(null); setTimeout(() => setToast(null), 4000); }
  }

  async function heal(researchRunId: string, gapId: string) {
    setBusy(`heal:${gapId}`);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/tickets/${ticketId}/heal`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ research_run_id: researchRunId, gap_id: gapId }),
      });
      const d = await r.json();
      setToast(d.ok
        ? `Heal status: ${d.status}${d.customer_message_sent ? " · customer notified" : ""}`
        : `Heal failed: ${d.error || d.status}`);
      await load();
      // Refresh the parent page so the ticket status banner updates
      setTimeout(() => window.location.reload(), 1500);
    } finally { setBusy(null); }
  }

  // Index heal_attempts by gap_id so we can mark already-healed gaps
  const healedGapIds = new Set(
    heals.filter(h => ["executed", "verified_closed", "skipped_idempotent", "verified_existing"].includes(h.status))
      .map(h => h.gap_id),
  );

  return (
    <div className="mt-4 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between p-4"
      >
        <h3 className="text-sm font-medium uppercase tracking-wider text-zinc-500">
          Research & Heal{runs.length > 0 && (
            <span className="ml-2 text-xs text-zinc-400">
              {runs.length} recipe{runs.length === 1 ? "" : "s"} · {runs.reduce((s, r) => s + r.gaps.length, 0)} gap{runs.reduce((s, r) => s + r.gaps.length, 0) === 1 ? "" : "s"}
            </span>
          )}
        </h3>
        <svg className={`h-4 w-4 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-zinc-100 px-4 pb-4 pt-3 dark:border-zinc-800 space-y-3">
          {toast && (
            <div className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">{toast}</div>
          )}

          {/* Run-recipe buttons */}
          <div>
            <p className="mb-1.5 text-[10px] uppercase tracking-wide text-zinc-400">Available recipes</p>
            <div className="flex flex-wrap gap-1.5">
              {available.map(rec => (
                <button
                  key={rec.slug}
                  onClick={() => runRecipe(rec.slug)}
                  disabled={busy === `run:${rec.slug}`}
                  title={rec.description}
                  className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                >
                  {busy === `run:${rec.slug}` ? "Running…" : `Run ${rec.slug}`}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <p className="text-xs text-zinc-400">Loading…</p>
          ) : runs.length === 0 ? (
            <p className="text-xs text-zinc-400">No research runs yet. Click a recipe button above to run one.</p>
          ) : (
            runs.map(run => (
              <div key={run.id} className="rounded-md border border-zinc-100 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">{run.recipe_slug}</p>
                    <p className="text-[10px] text-zinc-500">
                      v{run.recipe_version} · {new Date(run.ran_at).toLocaleString()} · {run.triggered_by}
                    </p>
                  </div>
                  <div className="text-[10px] text-zinc-500">
                    {run.findings.length} finding{run.findings.length === 1 ? "" : "s"} · {run.gaps.length} gap{run.gaps.length === 1 ? "" : "s"}
                  </div>
                </div>

                {/* Gaps */}
                {run.gaps.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {run.gaps.map(gap => {
                      const alreadyHealed = healedGapIds.has(gap.gap_id);
                      return (
                        <div key={gap.gap_id} className={`rounded-md border p-2 text-xs ${alreadyHealed ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30" : sevColor(gap.severity)}`}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="font-mono text-[10px] text-zinc-500">{gap.gap_id}</p>
                              <p className="mt-0.5 text-zinc-900 dark:text-zinc-100">{gap.description}</p>
                              {gap.proposed_heal && (
                                <p className="mt-1 text-[10px] text-zinc-500">
                                  Proposed heal: <span className="font-mono">{gap.proposed_heal.action_type}</span>
                                </p>
                              )}
                            </div>
                            {gap.proposed_heal && !alreadyHealed && (
                              <button
                                onClick={() => heal(run.id, gap.gap_id)}
                                disabled={busy === `heal:${gap.gap_id}`}
                                className="shrink-0 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                              >
                                {busy === `heal:${gap.gap_id}` ? "Healing…" : "Heal"}
                              </button>
                            )}
                            {alreadyHealed && (
                              <span className="shrink-0 rounded-md bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                                Healed
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Findings (collapsed by default) */}
                {run.findings.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-zinc-400">Findings ({run.findings.length})</summary>
                    <ul className="mt-1.5 space-y-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                      {run.findings.map((f, i) => (
                        <li key={i}><span className="font-mono">{f.type}</span> · {f.subject}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ))
          )}

          {heals.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-zinc-400">Heal history ({heals.length})</summary>
              <ul className="mt-1.5 space-y-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                {heals.map(h => (
                  <li key={h.id}>
                    <span className="font-mono">{h.gap_id}</span> → <span>{h.action_type}</span> · <span className={h.status === "verified_closed" ? "text-emerald-600" : "text-zinc-500"}>{h.status}</span>
                    {h.error && <span className="text-rose-600"> · {h.error}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function sevColor(s: "low" | "medium" | "high"): string {
  if (s === "high") return "border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30";
  if (s === "medium") return "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30";
  return "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900";
}
