"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Filter {
  id: string;
  filter_type: string;
  pattern: string;
  action: string;
  reason: string | null;
  is_active: boolean;
}

export default function EmailFiltersPage() {
  const workspace = useWorkspace();
  const [filters, setFilters] = useState<Filter[]>([]);
  const [loading, setLoading] = useState(true);
  const [newType, setNewType] = useState("domain");
  const [newPattern, setNewPattern] = useState("");
  const [newReason, setNewReason] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/email-filters`);
    if (res.ok) setFilters(await res.json());
    setLoading(false);
  };

  useEffect(() => { load(); }, [workspace.id]);

  const addFilter = async () => {
    if (!newPattern.trim()) return;
    setSaving(true);
    await fetch(`/api/workspaces/${workspace.id}/email-filters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter_type: newType, pattern: newPattern.trim(), reason: newReason.trim() || null }),
    });
    setNewPattern("");
    setNewReason("");
    await load();
    setSaving(false);
  };

  const toggleFilter = async (id: string, active: boolean) => {
    await fetch(`/api/workspaces/${workspace.id}/email-filters`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, is_active: active }),
    });
    await load();
  };

  const deleteFilter = async (id: string) => {
    await fetch(`/api/workspaces/${workspace.id}/email-filters`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await load();
  };

  const typeLabels: Record<string, string> = {
    domain: "Sender domain",
    sender: "Sender prefix",
    subject: "Subject contains",
  };

  const typeColors: Record<string, string> = {
    domain: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    sender: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
    subject: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Email Filters</h1>
        <p className="mt-1 text-sm text-zinc-500">Block spam, system notifications, and marketing emails from creating tickets.</p>
      </div>

      {/* Add new filter */}
      <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Add Filter</h2>
        <div className="flex flex-wrap gap-3">
          <select value={newType} onChange={(e) => setNewType(e.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            <option value="domain">Block domain</option>
            <option value="sender">Block sender prefix</option>
            <option value="subject">Block subject containing</option>
          </select>
          <input
            type="text" value={newPattern} onChange={(e) => setNewPattern(e.target.value)}
            placeholder={newType === "domain" ? "paypal.com" : newType === "sender" ? "noreply@" : "billing agreement"}
            className="flex-1 min-w-[200px] rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <input
            type="text" value={newReason} onChange={(e) => setNewReason(e.target.value)}
            placeholder="Reason (optional)"
            className="w-48 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <button onClick={addFilter} disabled={saving || !newPattern.trim()}
            className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
            Add
          </button>
        </div>
      </div>

      {/* Filter list */}
      {loading ? (
        <p className="text-sm text-zinc-400">Loading...</p>
      ) : (
        <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          {filters.length === 0 ? (
            <p className="p-4 text-sm text-zinc-400">No filters configured. All emails will create tickets.</p>
          ) : (
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {filters.map(f => (
                <div key={f.id} className={`flex items-center gap-3 px-4 py-3 ${!f.is_active ? "opacity-50" : ""}`}>
                  <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${typeColors[f.filter_type] || "bg-zinc-100 text-zinc-600"}`}>
                    {typeLabels[f.filter_type] || f.filter_type}
                  </span>
                  <span className="font-mono text-sm text-zinc-900 dark:text-zinc-100">{f.pattern}</span>
                  {f.reason && <span className="text-xs text-zinc-400">— {f.reason}</span>}
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      onClick={() => toggleFilter(f.id, !f.is_active)}
                      className={`rounded px-2 py-0.5 text-[10px] font-medium ${f.is_active ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500"}`}>
                      {f.is_active ? "Active" : "Disabled"}
                    </button>
                    <button onClick={() => deleteFilter(f.id)}
                      className="text-zinc-400 hover:text-red-500">
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
