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

interface DailyReport {
  id: string;
  date: string;
  summary: string | null;
  themes: Array<{ name: string; count: number; ticket_ids: string[]; description: string; severity?: string }>;
  recommendations: Array<{ priority: string; description: string }>;
  proposed_sonnet_prompt_ids: string[];
  proposed_grader_prompt_ids: string[];
  generated_at: string;
  model: string | null;
  cost_cents: number | null;
}

interface ProposedRule {
  id: string;
  title: string;
  content: string;
  status: string;
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
  const [report, setReport] = useState<DailyReport | null>(null);
  const [proposedSonnet, setProposedSonnet] = useState<ProposedRule[]>([]);
  const [proposedGrader, setProposedGrader] = useState<ProposedRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const loadReport = () => {
    fetch(`/api/workspaces/${workspace.id}/daily-analysis-reports?date=${date}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        setReport(d?.report || null);
        setProposedSonnet(d?.proposed_sonnet_prompts || []);
        setProposedGrader(d?.proposed_grader_prompts || []);
      });
  };

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setLoading(false); return; }
    Promise.all([
      fetch(`/api/workspaces/${workspace.id}/ticket-analyses?view=tickets&date=${date}`).then(r => r.ok ? r.json() : null),
      fetch(`/api/workspaces/${workspace.id}/daily-analysis-reports?date=${date}`).then(r => r.ok ? r.json() : null),
    ]).then(([a, r]) => {
      setAnalyses(a?.analyses || []);
      setReport(r?.report || null);
      setProposedSonnet(r?.proposed_sonnet_prompts || []);
      setProposedGrader(r?.proposed_grader_prompts || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [workspace.id, date]);

  const generateReport = async (regenerate: boolean) => {
    setGenerating(true);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/daily-analysis-reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, regenerate }),
      });
      if (res.ok) loadReport();
      else alert("Generate failed: " + (await res.text()));
    } finally {
      setGenerating(false);
    }
  };

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

      <DailyReportPanel
        date={date}
        report={report}
        proposedSonnet={proposedSonnet}
        proposedGrader={proposedGrader}
        analysesCount={analyses.length}
        generating={generating}
        onGenerate={generateReport}
        onRefresh={loadReport}
        workspaceId={workspace.id}
      />

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

function DailyReportPanel({
  date,
  report,
  proposedSonnet,
  proposedGrader,
  analysesCount,
  generating,
  onGenerate,
  onRefresh,
  workspaceId,
}: {
  date: string;
  report: DailyReport | null;
  proposedSonnet: ProposedRule[];
  proposedGrader: ProposedRule[];
  analysesCount: number;
  generating: boolean;
  onGenerate: (regenerate: boolean) => void;
  onRefresh: () => void;
  workspaceId: string;
}) {
  if (!report) {
    return (
      <div className="mb-6 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-5 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
        <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">No daily report for {date} yet</div>
        <p className="mt-1 text-xs text-zinc-500">
          {analysesCount > 0
            ? `Synthesize ${analysesCount} ticket analyses into a written report with proposed rule changes.`
            : "No ticket analyses on this day — nothing to synthesize."}
        </p>
        {analysesCount > 0 && (
          <button
            onClick={() => onGenerate(false)}
            disabled={generating}
            className="mt-3 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {generating ? "Generating…" : "Generate report"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Daily Report</div>
          <div className="mt-0.5 text-[11px] text-zinc-400">
            Generated {new Date(report.generated_at).toLocaleString()} · {report.model || "—"} · ${((report.cost_cents || 0) / 100).toFixed(2)}
          </div>
        </div>
        <button
          onClick={() => onGenerate(true)}
          disabled={generating}
          className="text-[11px] text-indigo-600 hover:text-indigo-500 disabled:opacity-50 dark:text-indigo-400"
        >
          {generating ? "Regenerating…" : "Regenerate"}
        </button>
      </div>

      {report.summary && (
        <div className="space-y-2 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
          {report.summary.split(/\n\n+/).map((p, i) => <p key={i}>{p}</p>)}
        </div>
      )}

      {report.themes?.length > 0 && (
        <div className="mt-5">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Themes</div>
          <div className="mt-2 space-y-2">
            {report.themes.map((t, i) => (
              <div key={i} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t.name}</span>
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">×{t.count}</span>
                  {t.severity && (
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      t.severity === "high" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" :
                      t.severity === "medium" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" :
                      "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                    }`}>{t.severity}</span>
                  )}
                </div>
                <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{t.description}</p>
                {t.ticket_ids?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {t.ticket_ids.map(tid => (
                      <a key={tid} href={`/dashboard/tickets/${tid}`} className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700">
                        {tid.slice(0, 8)}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {report.recommendations?.length > 0 && (
        <div className="mt-5">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Recommendations</div>
          <div className="mt-2 space-y-1.5">
            {report.recommendations.map((r, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${
                  r.priority === "high" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" :
                  r.priority === "medium" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" :
                  "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                }`}>{r.priority}</span>
                <span className="flex-1 text-zinc-700 dark:text-zinc-300">{r.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <ProposedRules
        title="Proposed AI agent rules"
        helpHref="/dashboard/settings/ai/prompts"
        rules={proposedSonnet}
        onAct={async (id, status) => {
          // sonnet-prompts PATCH uses body-based id
          const res = await fetch(`/api/workspaces/${workspaceId}/sonnet-prompts`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, status, enabled: status === "approved" }),
          });
          if (!res.ok) throw new Error(await res.text());
        }}
        onChange={onRefresh}
      />
      <ProposedRules
        title="Proposed grader rules"
        helpHref="/dashboard/settings/ai/grader-rules"
        rules={proposedGrader}
        onAct={async (id, status) => {
          // grader-prompts PATCH uses url-based id
          const res = await fetch(`/api/workspaces/${workspaceId}/grader-prompts/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status }),
          });
          if (!res.ok) throw new Error(await res.text());
        }}
        onChange={onRefresh}
      />
    </div>
  );
}

function ProposedRules({ title, helpHref, rules, onAct, onChange }: {
  title: string;
  helpHref: string;
  rules: ProposedRule[];
  onAct: (id: string, status: "approved" | "rejected") => Promise<void>;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  if (!rules.length) return null;

  const act = async (id: string, status: "approved" | "rejected") => {
    setBusy(id);
    try {
      await onAct(id, status);
      onChange();
    } catch (e) {
      alert(`Action failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-5">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</div>
        <a href={helpHref} className="text-[10px] text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">View all →</a>
      </div>
      <div className="mt-2 space-y-2">
        {rules.map(r => {
          const reviewed = r.status !== "proposed";
          return (
            <div key={r.id} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{r.title}</div>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-400">{r.content}</p>
                </div>
                <div className="flex shrink-0 flex-col gap-1.5">
                  {reviewed ? (
                    <span className={`rounded px-2 py-1 text-[10px] font-medium ${
                      r.status === "approved" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" :
                      "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                    }`}>{r.status}</span>
                  ) : (
                    <>
                      <button onClick={() => act(r.id, "approved")} disabled={busy === r.id} className="rounded bg-emerald-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
                        Approve
                      </button>
                      <button onClick={() => act(r.id, "rejected")} disabled={busy === r.id} className="rounded bg-zinc-200 px-2 py-1 text-[10px] font-medium text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700 disabled:opacity-50">
                        Reject
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
