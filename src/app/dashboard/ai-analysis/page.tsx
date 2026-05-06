"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface DailyRollup {
  date: string;
  avg_score: number | null;
  analyzed: number;
  action_items: number;
  admin_corrected: number;
  top_issues: { type: string; count: number }[];
}

interface TodayData {
  analyzed: number;
  avg_score: number | null;
  top_issues: { type: string; count: number }[];
  worst_today: { analysis_id: string; ticket_id: string; score: number; summary: string | null }[];
}

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

export default function AIAnalysisPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const [today, setToday] = useState<TodayData | null>(null);
  const [rollups, setRollups] = useState<DailyRollup[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch(`/api/workspaces/${workspace.id}/ticket-analyses?view=today`).then(r => r.ok ? r.json() : null),
      fetch(`/api/workspaces/${workspace.id}/ticket-analyses?view=daily`).then(r => r.ok ? r.json() : null),
    ]).then(([t, d]) => {
      setToday(t);
      setRollups(d?.rollups || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [workspace.id]);

  if (loading) return <div className="p-8 text-center text-zinc-400">Loading...</div>;

  const todayScore = today?.avg_score;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">AI Analysis</h1>
        <p className="mt-1 text-sm text-zinc-500">Real-time grading of every closed AI-handled ticket. Updates every 30 minutes.</p>
      </div>

      {/* Live today card */}
      {today && today.analyzed > 0 && (
        <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Today</div>
              <div className="mt-1 flex items-baseline gap-3">
                <span className={`text-3xl font-bold ${scoreColor(todayScore || 0)}`}>
                  {todayScore != null ? todayScore.toFixed(1) : "—"}
                </span>
                <span className="text-sm text-zinc-400">/ 10</span>
                <span className="text-sm text-zinc-500">· {today.analyzed} ticket{today.analyzed === 1 ? "" : "s"} analyzed so far</span>
              </div>
            </div>
            <div className={`flex h-16 w-16 items-center justify-center rounded-2xl ${scoreBg(todayScore || 0)}`}>
              <span className={`text-2xl font-bold ${scoreColor(todayScore || 0)}`}>{todayScore != null ? Math.round(todayScore) : "—"}</span>
            </div>
          </div>

          {today.top_issues.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {today.top_issues.map(i => (
                <span key={i.type} className="rounded bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {i.type} ×{i.count}
                </span>
              ))}
            </div>
          )}

          {today.worst_today.length > 0 && (
            <div className="mt-4 border-t border-zinc-100 pt-4 dark:border-zinc-800">
              <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Worst today (≤5)</div>
              <div className="mt-2 space-y-1.5">
                {today.worst_today.map(w => (
                  <a
                    key={w.analysis_id}
                    href={`/dashboard/tickets/${w.ticket_id}`}
                    className="flex items-start gap-3 rounded-md p-2 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  >
                    <span className={`shrink-0 rounded px-1.5 py-0.5 font-bold ${scoreBg(w.score)} ${scoreColor(w.score)}`}>{w.score}</span>
                    <span className="flex-1 text-zinc-600 dark:text-zinc-400">{w.summary || "(no summary)"}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Daily rollups */}
      <h2 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">Last 14 days</h2>
      {rollups.length === 0 ? (
        <p className="text-sm text-zinc-400">No analyses yet. They run every 30 minutes after tickets close.</p>
      ) : (
        <div className="space-y-3">
          {rollups.map(r => (
            <button
              key={r.date}
              onClick={() => router.push(`/dashboard/ai-analysis/${r.date}`)}
              className="flex w-full items-center gap-4 rounded-lg border border-zinc-200 bg-white p-4 text-left transition-all hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
            >
              <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-lg font-bold ${scoreBg(r.avg_score || 0)} ${scoreColor(r.avg_score || 0)}`}>
                {r.avg_score != null ? r.avg_score.toFixed(1) : "—"}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{r.date}</span>
                  {r.admin_corrected > 0 && (
                    <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400">
                      {r.admin_corrected} corrected
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-zinc-400">
                  <span>{r.analyzed} ticket{r.analyzed === 1 ? "" : "s"}</span>
                  <span>{r.action_items} action items</span>
                  {r.top_issues.slice(0, 3).map(i => (
                    <span key={i.type}>{i.type} ×{i.count}</span>
                  ))}
                </div>
              </div>
              <svg className="h-4 w-4 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
