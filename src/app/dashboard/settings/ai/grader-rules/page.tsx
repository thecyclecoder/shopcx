"use client";

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface GraderRule {
  id: string;
  title: string;
  content: string;
  status: "proposed" | "approved" | "rejected" | "archived";
  derived_from_ticket_id: string | null;
  proposed_at: string | null;
  reviewed_at: string | null;
  sort_order: number;
  created_at: string;
}

const STATUS_TABS = [
  { key: "proposed", label: "Proposed", desc: "Awaiting your review" },
  { key: "approved", label: "Approved", desc: "Active in the grader" },
  { key: "rejected", label: "Rejected", desc: "Dismissed" },
] as const;

export default function GraderRulesPage() {
  const workspace = useWorkspace();
  const [tab, setTab] = useState<"proposed" | "approved" | "rejected">("proposed");
  const [rules, setRules] = useState<GraderRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<GraderRule | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");

  const fetchRules = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/grader-prompts?status=${tab}`);
    if (res.ok) {
      const d = await res.json();
      setRules(d.rules || []);
    }
    setLoading(false);
  }, [workspace.id, tab]);

  useEffect(() => { fetchRules(); }, [fetchRules]);

  const setStatus = async (id: string, status: string) => {
    await fetch(`/api/workspaces/${workspace.id}/grader-prompts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    fetchRules();
  };

  const saveEdit = async () => {
    if (!editing) return;
    await fetch(`/api/workspaces/${workspace.id}/grader-prompts/${editing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: editTitle, content: editContent }),
    });
    setEditing(null);
    fetchRules();
  };

  const startEdit = (rule: GraderRule) => {
    setEditing(rule);
    setEditTitle(rule.title);
    setEditContent(rule.content);
  };

  return (
    <div className="p-4 sm:p-8">
      <div className="mb-6 flex items-center gap-2">
        <a href="/dashboard/settings/ai" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
          ← AI Settings
        </a>
      </div>

      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Grader Rules</h1>
      <p className="mt-2 text-sm text-zinc-500">
        Calibration rules for the AI quality grader. Rules are proposed when admins override an auto score on a ticket. Approved rules join the grader&apos;s permanent rubric.
      </p>

      <div className="mt-6 flex gap-1 rounded-lg border border-zinc-200 bg-zinc-100 p-1 dark:border-zinc-800 dark:bg-zinc-900">
        {STATUS_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {loading ? (
          <div className="text-sm text-zinc-400">Loading...</div>
        ) : rules.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-400 dark:border-zinc-800">
            No {tab} rules.
            {tab === "proposed" && (
              <p className="mt-2 text-xs">Rules are proposed when you override a ticket&apos;s auto score and check &ldquo;propose calibration rule.&rdquo;</p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {rules.map(rule => (
              <div key={rule.id} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{rule.title}</h3>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-400">{rule.content}</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-3 text-[11px] text-zinc-500 dark:border-zinc-800">
                  {rule.derived_from_ticket_id && (
                    <a href={`/dashboard/tickets/${rule.derived_from_ticket_id}`} className="text-indigo-600 hover:underline dark:text-indigo-400">
                      Source ticket →
                    </a>
                  )}
                  <span>{new Date(rule.created_at).toLocaleString()}</span>
                  <div className="ml-auto flex gap-2">
                    <button onClick={() => startEdit(rule)} className="text-zinc-600 hover:text-zinc-900 dark:hover:text-zinc-100">Edit</button>
                    {tab === "proposed" && (
                      <>
                        <button onClick={() => setStatus(rule.id, "approved")} className="rounded bg-emerald-600 px-2 py-1 text-white hover:bg-emerald-700">Approve</button>
                        <button onClick={() => setStatus(rule.id, "rejected")} className="rounded bg-zinc-200 px-2 py-1 text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-300">Reject</button>
                      </>
                    )}
                    {tab === "approved" && (
                      <button onClick={() => setStatus(rule.id, "rejected")} className="text-amber-600 hover:text-amber-700">Disable</button>
                    )}
                    {tab === "rejected" && (
                      <button onClick={() => setStatus(rule.id, "approved")} className="text-emerald-600 hover:text-emerald-700">Re-approve</button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-xl rounded-xl bg-white p-5 shadow-xl dark:bg-zinc-900">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Edit grader rule</h3>
            <label className="mt-4 block text-xs font-medium text-zinc-700 dark:text-zinc-300">Title</label>
            <input
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
            />
            <label className="mt-3 block text-xs font-medium text-zinc-700 dark:text-zinc-300">Content</label>
            <textarea
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              rows={6}
              className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">Cancel</button>
              <button onClick={saveEdit} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
