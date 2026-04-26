"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface Analysis {
  id: string;
  body: string;
  created_at: string;
  metadata: {
    date: string;
    overall_score: number;
    conversations_analyzed: number;
    issues: { type: string; description: string; ticket_index: number }[];
    action_items: { priority: string; description: string }[];
    channel_scores: Record<string, number>;
    ticket_ids?: string[]; // ordered — ticket_index N (1-based) → ticket_ids[N-1]
  };
}

const PRIORITY_COLORS: Record<string, string> = {
  high: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  low: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

const ISSUE_ICONS: Record<string, string> = {
  robotic: "Robotic",
  missed_opportunity: "Missed Opportunity",
  tone: "Tone",
  accuracy: "Accuracy",
  escalation: "Escalation",
};

function scoreColor(score: number): string {
  if (score >= 8) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 6) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

export default function AIAnalysisDetailPage() {
  const workspace = useWorkspace();
  const params = useParams();
  const router = useRouter();
  const analysisId = params.id as string;
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/notifications/${analysisId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { setAnalysis(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [workspace.id, analysisId]);

  if (loading) return <div className="p-8 text-center text-zinc-400">Loading...</div>;
  if (!analysis) return <div className="p-8 text-center text-zinc-400">Analysis not found</div>;

  const m = analysis.metadata;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <button onClick={() => router.push("/dashboard/ai-analysis")} className="mb-4 text-sm text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
        &larr; Back to AI Analysis
      </button>

      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">AI Report — {m.date}</h1>
          <p className="mt-1 text-sm text-zinc-500">{m.conversations_analyzed} conversations analyzed</p>
        </div>
        <div className={`flex h-16 w-16 items-center justify-center rounded-2xl text-2xl font-bold ${scoreColor(m.overall_score)} ${m.overall_score >= 8 ? "bg-emerald-50 dark:bg-emerald-900/20" : m.overall_score >= 6 ? "bg-amber-50 dark:bg-amber-900/20" : "bg-red-50 dark:bg-red-900/20"}`}>
          {m.overall_score}<span className="text-sm font-normal text-zinc-400">/10</span>
        </div>
      </div>

      {/* Summary */}
      <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">Summary</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{analysis.body}</p>
      </div>

      {/* Channel Scores */}
      {m.channel_scores && Object.keys(m.channel_scores).length > 0 && (
        <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">Channel Scores</h2>
          <div className="flex gap-4">
            {Object.entries(m.channel_scores).map(([ch, score]) => (
              <div key={ch} className="text-center">
                <div className={`text-xl font-bold ${scoreColor(score)}`}>{score}</div>
                <div className="text-xs capitalize text-zinc-500">{ch}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Action Items */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">Action Items ({m.action_items?.length || 0})</h2>
          {m.action_items?.length ? (
            <div className="space-y-3">
              {m.action_items.map((item, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${PRIORITY_COLORS[item.priority] || PRIORITY_COLORS.low}`}>
                    {item.priority}
                  </span>
                  <p className="text-sm text-zinc-700 dark:text-zinc-300">{item.description}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-zinc-400">No action items</p>
          )}
        </div>

        {/* Issues */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">Issues ({m.issues?.length || 0})</h2>
          {m.issues?.length ? (
            <div className="space-y-3">
              {m.issues.map((issue, i) => {
                const ticketId = m.ticket_ids?.[issue.ticket_index - 1];
                return (
                  <div key={i} className="rounded-md border border-zinc-100 px-3 py-2 dark:border-zinc-800">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                        {ISSUE_ICONS[issue.type] || issue.type}
                      </span>
                      {ticketId ? (
                        <a
                          href={`/dashboard/tickets/${ticketId}`}
                          className="text-[10px] text-indigo-600 hover:underline dark:text-indigo-400"
                        >
                          Conversation {issue.ticket_index} →
                        </a>
                      ) : (
                        <span className="text-[10px] text-zinc-400">Conversation {issue.ticket_index}</span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{issue.description}</p>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-zinc-400">No issues found</p>
          )}
        </div>
      </div>
    </div>
  );
}
