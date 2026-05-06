"use client";

import { useEffect, useState } from "react";

interface AnalysisData {
  id: string;
  score: number | null;
  admin_score: number | null;
  admin_score_reason: string | null;
  admin_corrected_at: string | null;
  issues: Array<{ type: string; description: string }>;
  action_items: Array<{ priority: string; description: string }>;
  summary: string | null;
  model: string | null;
  cost_cents: number | null;
  ai_message_count: number | null;
  window_start: string;
  window_end: string;
  created_at: string;
  trigger: string | null;
}

interface AnalysisResponse {
  latest: AnalysisData | null;
  history_count: number;
  cost: {
    conversation_cents: number;
    analysis_cents: number;
    total_cents: number;
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

export function TicketAnalysisPanel({ ticketId }: { ticketId: string }) {
  const [data, setData] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideScore, setOverrideScore] = useState<number>(8);
  const [overrideReason, setOverrideReason] = useState("");
  const [proposeRule, setProposeRule] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchData = () => {
    setLoading(true);
    fetch(`/api/tickets/${ticketId}/analysis`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { fetchData(); }, [ticketId]);

  const handleSubmitOverride = async () => {
    if (!overrideReason.trim()) return;
    setSaving(true);
    const res = await fetch(`/api/tickets/${ticketId}/analysis/override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ score: overrideScore, reason: overrideReason, propose_rule: proposeRule }),
    });
    setSaving(false);
    if (res.ok) {
      setOverrideOpen(false);
      setOverrideReason("");
      fetchData();
    } else {
      const err = await res.json();
      alert(`Override failed: ${err.error || "unknown"}`);
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="text-xs uppercase tracking-wide text-zinc-500">AI Analysis</div>
        <div className="mt-2 text-sm text-zinc-400">Loading...</div>
      </div>
    );
  }

  if (!data?.latest) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="text-xs uppercase tracking-wide text-zinc-500">AI Analysis</div>
        <div className="mt-2 text-sm text-zinc-400">Not yet analyzed</div>
        {data && data.cost.total_cents > 0 && (
          <div className="mt-3 border-t border-zinc-100 pt-3 text-[11px] text-zinc-500 dark:border-zinc-800">
            Ticket cost: ${(data.cost.total_cents / 100).toFixed(4)}
          </div>
        )}
      </div>
    );
  }

  const a = data.latest;
  const effectiveScore = a.admin_score ?? a.score ?? 0;
  const overridden = a.admin_score != null;

  return (
    <>
      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">AI Analysis</div>
            <div className="text-[10px] text-zinc-400">
              {data.history_count} run{data.history_count === 1 ? "" : "s"} · {a.ai_message_count} AI msg{a.ai_message_count === 1 ? "" : "s"} graded
            </div>
          </div>
          <div className={`flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold ${scoreColor(effectiveScore)} ${scoreBg(effectiveScore)}`}>
            {effectiveScore}<span className="text-[10px] font-normal text-zinc-400">/10</span>
          </div>
        </div>

        {overridden && (
          <div className="mt-2 rounded-md bg-indigo-50 px-2 py-1 text-[11px] text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-300">
            Overridden by admin (auto: {a.score}/10)
          </div>
        )}

        {a.summary && (
          <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">{a.summary}</p>
        )}

        {a.issues?.length > 0 && (
          <div className="mt-3 space-y-1">
            {a.issues.map((i, idx) => (
              <div key={idx} className="flex items-start gap-1.5 text-[11px]">
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                  {i.type}
                </span>
                <span className="flex-1 text-zinc-600 dark:text-zinc-400">{i.description}</span>
              </div>
            ))}
          </div>
        )}

        <div className="mt-3 flex items-center justify-between border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <button
            onClick={() => { setOverrideScore(effectiveScore); setOverrideOpen(true); }}
            className="text-[11px] font-medium text-indigo-600 hover:text-indigo-700"
          >
            Override score
          </button>
          <div className="text-[10px] text-zinc-400">
            ${(data.cost.total_cents / 100).toFixed(4)} (conv ${(data.cost.conversation_cents / 100).toFixed(4)} + analysis ${(data.cost.analysis_cents / 100).toFixed(4)})
          </div>
        </div>
      </div>

      {overrideOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl dark:bg-zinc-900">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Override AI Score</h3>
            <p className="mt-1 text-xs text-zinc-500">Auto score: <span className="font-medium">{a.score}/10</span></p>

            <label className="mt-4 block text-xs font-medium text-zinc-700 dark:text-zinc-300">Your score</label>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                <button
                  key={n}
                  onClick={() => setOverrideScore(n)}
                  className={`h-9 w-9 rounded-md border-2 text-sm font-medium transition-colors ${
                    overrideScore === n
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300"
                      : "border-zinc-200 text-zinc-600 hover:border-zinc-300 dark:border-zinc-700 dark:text-zinc-400"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>

            <label className="mt-4 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
              Why? (this helps the grader learn)
            </label>
            <textarea
              value={overrideReason}
              onChange={e => setOverrideReason(e.target.value)}
              rows={3}
              placeholder="e.g. Customer wanted a refund we can't give. AI declined politely and held firm — that's correct behavior."
              className="mt-2 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />

            <label className="mt-3 flex items-start gap-2 text-xs text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={proposeRule}
                onChange={e => setProposeRule(e.target.checked)}
                className="mt-0.5"
              />
              <span>Propose a calibration rule from this correction (admin reviews in Settings → AI → Grader Rules)</span>
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setOverrideOpen(false)}
                className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitOverride}
                disabled={!overrideReason.trim() || saving}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
