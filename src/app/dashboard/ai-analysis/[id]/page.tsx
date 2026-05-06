"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface AnalysisRow {
  id: string;
  ticket_id: string;
  score: number | null;
  admin_score: number | null;
  admin_score_reason: string | null;
  summary: string | null;
  issues: { type: string; description: string }[];
  action_items: { priority: string; description: string }[];
  created_at: string;
  cost_cents: number | null;
  ai_message_count: number | null;
  trigger: string | null;
  tickets?: { subject: string | null } | null;
}

const PRIORITY_COLORS: Record<string, string> = {
  high: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  low: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

function scoreColor(score: number): string {
  if (score >= 8) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 6) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function scoreBg(score: number): string {
  if (score >= 8) return "bg-emerald-50 dark:bg-emerald-900/20";
  if (score >= 6) return "bg-amber-50 dark:bg-amber-900/20";
  return "bg-red-50 dark:bg-red-900/20";
}

export default function AIAnalysisDayPage() {
  const workspace = useWorkspace();
  const params = useParams();
  const router = useRouter();
  // The [id] segment is now a date (YYYY-MM-DD) for the new schema.
  // Legacy entries used a UUID — render an empty state for those (rare).
  const date = params.id as string;
  const [analyses, setAnalyses] = useState<AnalysisRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setLoading(false); return; }
    fetch(`/api/workspaces/${workspace.id}/ticket-analyses?view=tickets&date=${date}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { setAnalyses(d?.analyses || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [workspace.id, date]);

  if (loading) return <div className="p-8 text-center text-zinc-400">Loading...</div>;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <button onClick={() => router.push("/dashboard/ai-analysis")} className="mb-4 text-sm text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
          &larr; AI Analysis
        </button>
        <p className="text-sm text-zinc-500">Legacy analysis report — please return to the new date-grouped view.</p>
      </div>
    );
  }

  const scores = analyses.map(a => (a.admin_score ?? a.score) as number).filter(s => s != null);
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <button onClick={() => router.push("/dashboard/ai-analysis")} className="mb-4 text-sm text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
        &larr; AI Analysis
      </button>

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{date}</h1>
          <p className="mt-1 text-sm text-zinc-500">{analyses.length} ticket{analyses.length === 1 ? "" : "s"} analyzed</p>
        </div>
        {avg != null && (
          <div className={`flex h-16 w-16 items-center justify-center rounded-2xl text-2xl font-bold ${scoreColor(avg)} ${scoreBg(avg)}`}>
            {avg.toFixed(1)}
          </div>
        )}
      </div>

      {analyses.length === 0 ? (
        <p className="text-sm text-zinc-400">No analyses on this day.</p>
      ) : (
        <div className="space-y-3">
          {analyses.map(a => {
            const effectiveScore = a.admin_score ?? a.score ?? 0;
            const overridden = a.admin_score != null;
            return (
              <a
                key={a.id}
                href={`/dashboard/tickets/${a.ticket_id}`}
                className="block rounded-lg border border-zinc-200 bg-white p-4 transition-all hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
              >
                <div className="flex items-start gap-3">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-base font-bold ${scoreColor(effectiveScore)} ${scoreBg(effectiveScore)}`}>
                    {effectiveScore}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {a.tickets?.subject || a.ticket_id.slice(0, 8)}
                      </span>
                      {overridden && (
                        <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                          overridden (auto: {a.score})
                        </span>
                      )}
                    </div>
                    {a.summary && (
                      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{a.summary}</p>
                    )}
                    {a.issues?.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {a.issues.map((i, idx) => (
                          <span key={idx} className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                            {i.type}
                          </span>
                        ))}
                      </div>
                    )}
                    {a.action_items?.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {a.action_items.map((ai, idx) => (
                          <div key={idx} className="flex items-start gap-1.5 text-[11px]">
                            <span className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${PRIORITY_COLORS[ai.priority] || PRIORITY_COLORS.low}`}>
                              {ai.priority}
                            </span>
                            <span className="flex-1 text-zinc-600 dark:text-zinc-400">{ai.description}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <span className="shrink-0 text-[10px] text-zinc-400">${((a.cost_cents || 0) / 100).toFixed(4)}</span>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
