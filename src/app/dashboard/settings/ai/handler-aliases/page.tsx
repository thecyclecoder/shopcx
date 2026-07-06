"use client";

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Proposal {
  id: string;
  source_type: string;
  ticket_id: string | null;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  suggested_target: string | null;
  suggested_at: string | null;
  suggested_model: string | null;
  suggested_reasoning: string | null;
  status: "pending" | "approved" | "declined";
  reviewed_at: string | null;
  created_at: string;
}

interface Alias {
  id: string;
  workspace_id: string | null;
  source_type: string;
  target_type: string;
  active: boolean;
  created_at: string;
}

const STATUS_TABS = [
  { key: "pending",  label: "Pending",  desc: "Awaiting your review" },
  { key: "approved", label: "Approved", desc: "Now aliased in your workspace" },
  { key: "declined", label: "Declined", desc: "Ignored — still counted" },
] as const;

export default function HandlerAliasesPage() {
  const workspace = useWorkspace();
  const [tab, setTab] = useState<"pending" | "approved" | "declined">("pending");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [loading, setLoading] = useState(true);
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/handler-aliases?status=${tab}`);
    if (res.ok) {
      const d = await res.json();
      setProposals(d.proposals || []);
      setAliases(d.aliases || []);
    }
    setLoading(false);
  }, [workspace.id, tab]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const decide = async (proposal: Proposal, decision: "approved" | "declined") => {
    const target = overrides[proposal.id] ?? proposal.suggested_target ?? "";
    if (decision === "approved" && !target) {
      alert("Enter a target handler key before approving.");
      return;
    }
    const res = await fetch(`/api/workspaces/${workspace.id}/handler-aliases/${proposal.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, target_type: target }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Failed: ${err.error || res.status}`);
      return;
    }
    setOverrides(prev => { const next = { ...prev }; delete next[proposal.id]; return next; });
    fetchData();
  };

  return (
    <div className="p-4 sm:p-8">
      <div className="mb-6 flex items-center gap-2">
        <a href="/dashboard/settings/ai" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
          ← AI Settings
        </a>
      </div>

      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Handler Aliases</h1>
      <p className="mt-2 text-sm text-zinc-500">
        Sonnet occasionally emits an action_type that does not match any registered handler (e.g. <code>cancel_subscription</code> instead of <code>cancel</code>). The executor records those misses here so you can approve a permanent alias — the executor then routes the miss to a real handler on the next hit.
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
        ) : proposals.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-400 dark:border-zinc-800">
            No {tab} proposals.
          </div>
        ) : (
          <div className="space-y-3">
            {proposals.map(p => (
              <div key={p.id} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex flex-wrap items-baseline gap-3">
                  <code className="rounded bg-zinc-100 px-2 py-0.5 text-sm font-semibold text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">{p.source_type}</code>
                  <span className="text-sm text-zinc-500">seen {p.occurrences}× · last {new Date(p.last_seen).toLocaleString()}</span>
                </div>

                {p.suggested_target && (
                  <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                    Suggested target: <code className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">{p.suggested_target}</code>
                    {p.suggested_reasoning && <span className="ml-2 text-zinc-400">— {p.suggested_reasoning}</span>}
                  </p>
                )}
                {!p.suggested_target && tab === "pending" && (
                  <p className="mt-2 text-sm text-zinc-400">No suggestion yet {p.occurrences < 3 ? `(waiting for occurrence ${p.occurrences + 1}/3)` : "(suggestion pending)"}</p>
                )}

                {tab === "pending" && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                    <label className="text-xs text-zinc-500">Target:</label>
                    <input
                      type="text"
                      value={overrides[p.id] ?? p.suggested_target ?? ""}
                      onChange={(e) => setOverrides(prev => ({ ...prev, [p.id]: e.target.value }))}
                      placeholder="e.g. cancel"
                      className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800"
                    />
                    <button onClick={() => decide(p, "approved")} className="rounded bg-emerald-600 px-3 py-1 text-sm text-white hover:bg-emerald-700">Approve</button>
                    <button onClick={() => decide(p, "declined")} className="rounded bg-zinc-200 px-3 py-1 text-sm text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-300">Decline</button>
                    {p.ticket_id && (
                      <a href={`/dashboard/tickets/${p.ticket_id}`} className="ml-auto text-xs text-indigo-600 hover:underline dark:text-indigo-400">
                        Source ticket →
                      </a>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <h2 className="mt-10 text-lg font-semibold text-zinc-900 dark:text-zinc-100">Active alias catalog</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Globals apply to every workspace; workspace-scoped rows override or disable globals for you specifically.
      </p>
      <div className="mt-3 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
        {aliases.length === 0 && <p className="p-4 text-sm text-zinc-400">No aliases yet.</p>}
        {aliases.map(a => (
          <div key={a.id} className="flex items-center gap-3 p-3 text-sm">
            <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">{a.source_type}</code>
            <span className="text-zinc-400">→</span>
            <code className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">{a.target_type}</code>
            <span className={`ml-auto rounded-full px-2 py-0.5 text-xs ${a.workspace_id === null ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"}`}>
              {a.workspace_id === null ? "global" : "workspace"}
            </span>
            {!a.active && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">inactive</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
