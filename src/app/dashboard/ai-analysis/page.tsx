"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface Analysis {
  id: string;
  title: string;
  body: string;
  created_at: string;
  metadata: {
    date: string;
    overall_score: number;
    conversations_analyzed: number;
    issues: { type: string; description: string; ticket_index: number }[];
    action_items: { priority: string; description: string }[];
    channel_scores: Record<string, number>;
  };
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
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/notifications?type=system&metadata_type=ai_nightly_analysis&limit=30`)
      .then(r => r.json())
      .then(data => {
        setAnalyses((data.notifications || data || []).filter((n: Analysis) => n.metadata?.overall_score != null));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [workspace.id]);

  if (loading) return <div className="p-8 text-center text-zinc-400">Loading...</div>;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">AI Analysis</h1>
        <p className="mt-1 text-sm text-zinc-500">Daily performance reports from the AI nightly review</p>
      </div>

      {analyses.length === 0 ? (
        <p className="text-sm text-zinc-400">No analyses yet. Reports are generated nightly.</p>
      ) : (
        <div className="space-y-3">
          {analyses.map(a => {
            const m = a.metadata;
            const highPriority = m.action_items?.filter(ai => ai.priority === "high").length || 0;
            return (
              <button
                key={a.id}
                onClick={() => router.push(`/dashboard/ai-analysis/${a.id}`)}
                className="flex w-full items-center gap-4 rounded-lg border border-zinc-200 bg-white p-4 text-left transition-all hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
              >
                {/* Score */}
                <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-lg font-bold ${scoreBg(m.overall_score)} ${scoreColor(m.overall_score)}`}>
                  {m.overall_score}
                </div>

                {/* Details */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{m.date}</span>
                    {highPriority > 0 && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
                        {highPriority} high priority
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-zinc-500">{a.body?.slice(0, 120)}</p>
                  <div className="mt-1 flex gap-3 text-[11px] text-zinc-400">
                    <span>{m.conversations_analyzed} conversations</span>
                    <span>{m.issues?.length || 0} issues</span>
                    <span>{m.action_items?.length || 0} actions</span>
                  </div>
                </div>

                <svg className="h-4 w-4 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
