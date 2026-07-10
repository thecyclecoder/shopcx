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
  new_tickets?: number;
  handled_tickets?: number;
  handled_cheap?: number;
  handled_sol?: number;
  avg_score: number | null;
  top_issues: { type: string; count: number }[];
  worst_today: { analysis_id: string; ticket_id: string; score: number; summary: string | null }[];
}

interface DecisionRow {
  id: string;
  sonnet_prompt_id: string;
  decision: "accept" | "reject" | "merge" | "supersede" | "human_review" | "revise";
  confidence: number;
  reasoning: string;
  references_json: { type: string; id: string; why: string }[];
  suggested_revisions: string | null;
  merge_target_id: string | null;
  supersede_target_id: string | null;
  model: string;
  source: "cron" | "manual_override" | "safety_test";
  created_at: string;
  prompt: {
    id: string;
    title: string;
    content: string;
    category: string;
    status: string;
    enabled: boolean;
    auto_decision: string | null;
  } | null;
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

const DECISION_COLORS: Record<string, string> = {
  accept: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  reject: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  merge: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  supersede: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  human_review: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  revise: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200",
};

type Tab = "daily" | "auto";

export default function AIAnalysisPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("daily");
  const [today, setToday] = useState<TodayData | null>(null);
  const [rollups, setRollups] = useState<DailyRollup[]>([]);
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    if (tab === "daily") {
      Promise.all([
        fetch(`/api/workspaces/${workspace.id}/ticket-analyses?view=today`).then(r => r.ok ? r.json() : null),
        fetch(`/api/workspaces/${workspace.id}/ticket-analyses?view=daily`).then(r => r.ok ? r.json() : null),
      ]).then(([t, d]) => {
        setToday(t);
        setRollups(d?.rollups || []);
        setLoading(false);
      }).catch(() => setLoading(false));
    } else if (tab === "auto") {
      fetch(`/api/workspaces/${workspace.id}/sonnet-prompt-decisions?view=recent`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { setDecisions(d?.decisions || []); setLoading(false); })
        .catch(() => setLoading(false));
    }
  }, [workspace.id, tab]);

  async function override(promptId: string, action: "accept" | "reject" | "revert") {
    setBusyId(promptId);
    try {
      const r = await fetch(`/api/sonnet-prompts/${promptId}/override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(`Override failed: ${j.error || r.statusText}`);
      } else if (tab === "auto") {
        const d = await fetch(`/api/workspaces/${workspace.id}/sonnet-prompt-decisions?view=recent`).then(r => r.json());
        setDecisions(d?.decisions || []);
      }
    } finally {
      setBusyId(null);
    }
  }

  const todayScore = today?.avg_score;

  return (
    <div className="mx-auto w-full max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">AI Analysis</h1>
        <p className="mt-1 text-sm text-zinc-500">Real-time grading + nightly auto-review of proposed rules.</p>
      </div>

      <div className="mb-6 border-b border-zinc-200 dark:border-zinc-800">
        <nav className="-mb-px flex gap-6">
          {[
            { k: "daily", label: "Daily" },
            { k: "auto", label: "Auto-decisions" },
          ].map(t => (
            <button
              key={t.k}
              onClick={() => setTab(t.k as Tab)}
              className={`border-b-2 pb-2 text-sm font-medium ${tab === t.k ? "border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400" : "border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {loading && <div className="p-8 text-center text-zinc-400">Loading...</div>}

      {!loading && tab === "daily" && (
        <>
          {today && (today.analyzed > 0 || (today.handled_tickets ?? 0) > 0) && (
            <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Today</div>
                  <div className="mt-1 flex items-baseline gap-3">
                    <span className={`text-3xl font-bold ${scoreColor(todayScore || 0)}`}>
                      {todayScore != null ? todayScore.toFixed(1) : "—"}
                    </span>
                    <span className="text-sm text-zinc-400">/ 10</span>
                    <span className="text-sm text-zinc-500">
                      · {today.analyzed} of {today.handled_tickets ?? today.analyzed} handled ticket{(today.handled_tickets ?? today.analyzed) === 1 ? "" : "s"} graded
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                    <span><span className="font-semibold text-zinc-700 dark:text-zinc-300">{today.new_tickets ?? 0}</span> new today</span>
                    <span><span className="font-semibold text-zinc-700 dark:text-zinc-300">{today.handled_tickets ?? 0}</span> handled today</span>
                    {(today.handled_cheap ?? 0) + (today.handled_sol ?? 0) > 0 && (
                      <span className="text-zinc-400">
                        ({today.handled_cheap ?? 0} cheap · {today.handled_sol ?? 0} Sol)
                      </span>
                    )}
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
        </>
      )}

      {!loading && tab === "auto" && (
        <div className="space-y-3">
          {decisions.length === 0 ? (
            <p className="text-sm text-zinc-400">No auto-decisions yet. Enable <code>sonnet_auto_review_enabled</code> on the workspace to begin auto-reviewing proposed prompts.</p>
          ) : decisions.map(d => (
            <div key={d.id} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${DECISION_COLORS[d.decision]}`}>{d.decision}</span>
                <span className="text-xs text-zinc-400">confidence</span>
                <div className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div className="h-full bg-indigo-500" style={{ width: `${Math.round(d.confidence * 100)}%` }} />
                </div>
                <span className="text-xs text-zinc-500">{Math.round(d.confidence * 100)}%</span>
                <span className="ml-auto text-[11px] text-zinc-400">{new Date(d.created_at).toLocaleString()}</span>
                <span
                  className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-900/30 dark:text-sky-300"
                  title="Reviewed by Prue (box-session prompt-review agent) under June, CS Director. June owns conversation-rule quality; the agent optimizes 'review each proposal well' within her rails."
                >
                  {d.source === "cron" ? "Prue · under June" : d.source}
                </span>
              </div>
              <div className="mt-3">
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{d.prompt?.title || "(prompt deleted)"}</div>
                {d.prompt?.content && (
                  <div className="mt-1 line-clamp-2 text-xs text-zinc-500">{d.prompt.content}</div>
                )}
              </div>
              <div className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">{d.reasoning}</div>
              {d.suggested_revisions && (
                <div className="mt-2 rounded bg-zinc-50 p-2 text-xs italic text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  Suggested revision: {d.suggested_revisions}
                </div>
              )}
              {d.references_json.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {d.references_json.map((r, i) => (
                    <span key={i} className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" title={r.why}>
                      {r.type}:{r.id.slice(0, 8)}
                    </span>
                  ))}
                </div>
              )}
              {d.prompt && (
                <div className="mt-3 flex gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                  <button
                    disabled={busyId === d.prompt.id}
                    onClick={() => override(d.prompt!.id, "accept")}
                    className="rounded bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-40 dark:bg-emerald-900/30 dark:text-emerald-300"
                  >Accept manually</button>
                  <button
                    disabled={busyId === d.prompt.id}
                    onClick={() => override(d.prompt!.id, "reject")}
                    className="rounded bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-40 dark:bg-red-900/30 dark:text-red-300"
                  >Reject manually</button>
                  <button
                    disabled={busyId === d.prompt.id}
                    onClick={() => override(d.prompt!.id, "revert")}
                    className="rounded bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-40 dark:bg-zinc-800 dark:text-zinc-300"
                  >Revert to proposed</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
