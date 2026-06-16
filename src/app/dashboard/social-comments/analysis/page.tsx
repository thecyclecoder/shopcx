"use client";

/**
 * AI moderation analyzer — review what the two-pass AI decided across
 * recent comments. Filter to "needs review" cases (escalated, hidden,
 * bad-rated) to find prompts/rules that need tightening.
 *
 * Each row exposes the AI's reasoning + three-lens considers + which
 * KB/macro sources it used, plus a quick rate (good / bad / needs revision).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface CommentRow {
  id: string;
  body: string;
  is_ad: boolean;
  status: string;
  sentiment: string | null;
  meta_sender_name: string | null;
  meta_sender_username: string | null;
  ai_action: string | null;
  ai_reasoning: string | null;
  ai_reply_body: string | null;
  ai_visibility: string | null;
  ai_model: string | null;
  ai_considers: {
    helpfulness?: string;
    public_impact?: string;
    sales_consideration?: string;
  } | null;
  ai_kb_sources: string[] | null;
  human_rating: string | null;
  created_at: string;
  meta_pages?: { platform: string; meta_page_name: string | null };
  products?: { title: string; handle: string } | null;
}

const ACTIONS = ["all", "reply", "hidden_reply", "like", "hide", "delete", "ignore", "escalate"] as const;
const RATINGS = ["all", "unrated", "good", "bad", "needs_revision"] as const;

export default function CommentAnalysisPage() {
  const { id: workspaceId } = useWorkspace();
  const [rows, setRows] = useState<CommentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState<(typeof ACTIONS)[number]>("all");
  const [ratingFilter, setRatingFilter] = useState<(typeof RATINGS)[number]>("all");
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (actionFilter !== "all") params.set("ai_action", actionFilter);
    if (ratingFilter === "unrated") params.set("human_rating", "null");
    else if (ratingFilter !== "all") params.set("human_rating", ratingFilter);
    params.set("status", "all");
    params.set("limit", "100");
    const res = await fetch(`/api/workspaces/${workspaceId}/social-comments?${params}`);
    const d = await res.json();
    setRows(d.comments || []);
    setLoading(false);
  }, [workspaceId, actionFilter, ratingFilter]);

  useEffect(() => { void load(); }, [load]);

  async function rate(commentId: string, rating: string | null, notes?: string) {
    setSavingId(commentId);
    try {
      await fetch(`/api/workspaces/${workspaceId}/social-comments/${commentId}/rate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, notes }),
      });
      setRows(prev => prev.map(r => r.id === commentId ? { ...r, human_rating: rating } : r));
    } finally {
      setSavingId(null);
    }
  }

  const counts = useMemo(() => ({
    total: rows.length,
    good: rows.filter(r => r.human_rating === "good").length,
    bad: rows.filter(r => r.human_rating === "bad").length,
    needs: rows.filter(r => r.human_rating === "needs_revision").length,
    unrated: rows.filter(r => !r.human_rating).length,
  }), [rows]);

  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link href="/dashboard/social-comments" className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            ← Back to comments
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">AI moderation analyzer</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Review the two-pass AI&apos;s decisions. Rate misclassifications so we can tighten the prompts. Pass 1 is Haiku (triage); Pass 2 is Opus (reply reasoning).
          </p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <label className="flex items-center gap-2 text-xs">
          <span className="text-zinc-500">Action:</span>
          <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value as typeof actionFilter)}
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800">
            {ACTIONS.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="text-zinc-500">Rating:</span>
          <select value={ratingFilter} onChange={(e) => setRatingFilter(e.target.value as typeof ratingFilter)}
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800">
            {RATINGS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <span className="ml-auto text-xs text-zinc-500">
          {counts.total} total · <span className="text-emerald-600">{counts.good} good</span> · <span className="text-red-600">{counts.bad} bad</span> · <span className="text-amber-600">{counts.needs} needs revision</span> · {counts.unrated} unrated
        </span>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900">
          No comments match the current filters.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map(r => (
            <div key={r.id} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">
                      {r.meta_sender_name || r.meta_sender_username || "(unknown)"}
                    </span>
                    <span className="text-zinc-400">·</span>
                    <span className="text-zinc-500">{r.meta_pages?.platform}</span>
                    <span className="text-zinc-400">·</span>
                    <span className="text-zinc-500">{r.is_ad ? "Ad" : "Organic"}</span>
                    {r.products && (<><span className="text-zinc-400">·</span>
                      <Link href={`/dashboard/products?handle=${r.products.handle}`} className="text-blue-600 hover:underline">{r.products.title}</Link></>)}
                    <span className="text-zinc-400">·</span>
                    <span className="text-zinc-500">{new Date(r.created_at).toLocaleString()}</span>
                  </div>
                  <p className="mt-2 text-sm text-zinc-900 dark:text-zinc-100">{r.body}</p>
                </div>
                <Link
                  href={`/dashboard/social-comments/${r.id}`}
                  className="shrink-0 text-xs text-blue-600 hover:underline"
                >
                  Open →
                </Link>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="rounded-md border border-zinc-100 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950">
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`rounded px-2 py-0.5 font-medium ${actionBadgeColor(r.ai_action)}`}>{r.ai_action || "—"}</span>
                    {r.ai_visibility && (
                      <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${r.ai_visibility === "hidden" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"}`}>
                        {r.ai_visibility}
                      </span>
                    )}
                    {r.ai_model && (
                      <span className="text-[10px] font-mono text-zinc-400">{r.ai_model.replace("claude-", "")}</span>
                    )}
                    {r.sentiment && (
                      <span className="text-[10px] text-zinc-500">{r.sentiment}</span>
                    )}
                  </div>
                  {r.ai_reasoning && <p className="mt-2 text-xs text-zinc-700 dark:text-zinc-300">{r.ai_reasoning}</p>}
                  {r.ai_reply_body && (
                    <div className="mt-2 rounded bg-white p-2 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                      <span className="mr-1 text-[10px] uppercase tracking-wide text-zinc-400">Drafted reply</span>
                      <p className="mt-1">{r.ai_reply_body}</p>
                    </div>
                  )}
                  {r.ai_considers && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-zinc-400">Considers</summary>
                      <div className="mt-2 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                        {r.ai_considers.helpfulness && <p><strong>Helpfulness:</strong> {r.ai_considers.helpfulness}</p>}
                        {r.ai_considers.public_impact && <p><strong>Public impact:</strong> {r.ai_considers.public_impact}</p>}
                        {r.ai_considers.sales_consideration && <p><strong>Sales:</strong> {r.ai_considers.sales_consideration}</p>}
                      </div>
                    </details>
                  )}
                  {r.ai_kb_sources && r.ai_kb_sources.length > 0 && (
                    <p className="mt-2 text-[10px] text-zinc-400">Used: {r.ai_kb_sources.join(", ")}</p>
                  )}
                </div>

                <div className="rounded-md border border-zinc-100 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                  <p className="text-[10px] uppercase tracking-wide text-zinc-400">Your rating</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(["good", "needs_revision", "bad"] as const).map(rt => (
                      <button
                        key={rt}
                        type="button"
                        disabled={savingId === r.id}
                        onClick={() => rate(r.id, r.human_rating === rt ? null : rt)}
                        className={`rounded-md px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${ratingButtonStyle(rt, r.human_rating === rt)}`}
                      >
                        {rt === "needs_revision" ? "Needs revision" : rt[0].toUpperCase() + rt.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function actionBadgeColor(action: string | null): string {
  switch (action) {
    case "reply": return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300";
    case "hidden_reply": return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300";
    case "like": return "bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300";
    case "hide": return "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
    case "delete": return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300";
    case "ignore": return "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500";
    case "escalate": return "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300";
    default: return "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500";
  }
}

function ratingButtonStyle(rt: "good" | "bad" | "needs_revision", active: boolean): string {
  const map = {
    good: active ? "bg-emerald-600 text-white" : "border border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400",
    bad: active ? "bg-red-600 text-white" : "border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400",
    needs_revision: active ? "bg-amber-600 text-white" : "border border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-400",
  };
  return map[rt];
}
