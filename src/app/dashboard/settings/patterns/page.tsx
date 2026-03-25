"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Pattern {
  id: string;
  workspace_id: string | null;
  category: string;
  name: string;
  phrases: string[];
  match_target: string;
  priority: number;
  auto_tag: string | null;
  auto_action: string | null;
  active: boolean;
  source: string;
  is_global: boolean;
  workspace_enabled: boolean;
}

const CATEGORY_COLORS: Record<string, string> = {
  where_is_order: "bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400",
  tracking_status: "bg-cyan-100 text-cyan-600 dark:bg-cyan-900/30 dark:text-cyan-400",
  not_delivered: "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400",
  subscription_mgmt: "bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400",
  cancel_request: "bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400",
  return_request: "bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400",
  custom: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

export default function PatternsPage() {
  const workspace = useWorkspace();
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    category: string;
    phrases: string;
    match_target: string;
    priority: number;
    auto_tag: string;
  } | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [feedback, setFeedback] = useState<{
    id: string; tag_removed: string; agent_reason: string | null;
    ai_analysis: { assessment: string; explanation: string; suggested_action: string; phrase_to_remove?: string; suggested_negative?: string } | null;
    status: string; created_at: string;
  }[]>([]);

  if (!["owner", "admin"].includes(workspace.role)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8">
        <p className="text-sm text-zinc-400">You don&apos;t have permission to view this page.</p>
      </div>
    );
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/patterns`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setPatterns(d); })
      .finally(() => setLoading(false));
    fetch(`/api/workspaces/${workspace.id}/pattern-feedback`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setFeedback(d); })
      .catch(() => {});
  }, [workspace.id]);

  const handleToggleGlobal = async (patternId: string, currentEnabled: boolean) => {
    const res = await fetch(`/api/workspaces/${workspace.id}/patterns/${patternId}/override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !currentEnabled }),
    });
    if (res.ok) {
      setPatterns(prev => prev.map(p => p.id === patternId ? { ...p, workspace_enabled: !currentEnabled } : p));
    }
  };

  const handleSave = async () => {
    if (!editing) return;
    const phrases = editing.phrases.split("\n").map(p => p.trim()).filter(Boolean);
    const payload = {
      name: editing.name,
      category: editing.category,
      phrases,
      match_target: editing.match_target,
      priority: editing.priority,
      auto_tag: editing.auto_tag || null,
    };

    const url = isNew
      ? `/api/workspaces/${workspace.id}/patterns`
      : `/api/workspaces/${workspace.id}/patterns/${editing.id}`;

    const res = await fetch(url, {
      method: isNew ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      const saved = await res.json();
      if (isNew) {
        setPatterns(prev => [...prev, { ...saved, is_global: false, workspace_enabled: true }]);
      } else {
        setPatterns(prev => prev.map(p => p.id === saved.id ? { ...p, ...saved } : p));
      }
      setEditing(null);
      setIsNew(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this pattern?")) return;
    await fetch(`/api/workspaces/${workspace.id}/patterns/${id}`, { method: "DELETE" });
    setPatterns(prev => prev.filter(p => p.id !== id));
  };

  const globalPatterns = patterns.filter(p => p.is_global);
  const workspacePatterns = patterns.filter(p => !p.is_global);

  if (loading) return <div className="p-8 text-sm text-zinc-400">Loading...</div>;

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Smart Patterns</h1>
          <p className="mt-1 text-sm text-zinc-500">Auto-tag incoming tickets based on message content.</p>
        </div>
        <button
          onClick={() => {
            setIsNew(true);
            setEditing({ id: "", name: "", category: "custom", phrases: "", match_target: "both", priority: 50, auto_tag: "" });
          }}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          New Pattern
        </button>
      </div>

      {/* Editor */}
      {editing && (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{isNew ? "New Pattern" : "Edit Pattern"}</h2>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-500">Name</label>
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-500">Category</label>
              <input value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                placeholder="e.g. where_is_order, custom"
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-500">Auto-Tag</label>
              <input value={editing.auto_tag} onChange={(e) => setEditing({ ...editing, auto_tag: e.target.value })}
                placeholder="e.g. where-is-order"
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
            </div>
            <div className="flex gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-500">Match Target</label>
                <select value={editing.match_target} onChange={(e) => setEditing({ ...editing, match_target: e.target.value })}
                  className="mt-1 block rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
                  <option value="both">Subject + Body</option>
                  <option value="subject">Subject Only</option>
                  <option value="body">Body Only</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-500">Priority</label>
                <input type="number" value={editing.priority} onChange={(e) => setEditing({ ...editing, priority: parseInt(e.target.value) || 50 })}
                  className="mt-1 block w-20 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
              </div>
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-zinc-500">Phrases (one per line)</label>
              <textarea rows={6} value={editing.phrases} onChange={(e) => setEditing({ ...editing, phrases: e.target.value })}
                placeholder={"where is my order\nhaven't received\nnot received"}
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button onClick={handleSave} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
              {isNew ? "Create" : "Save"}
            </button>
            <button onClick={() => { setEditing(null); setIsNew(false); }} className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Global Patterns */}
      {!editing && (
        <>
          {/* Feedback review queue */}
          {feedback.filter(f => f.status === "pending").length > 0 && (
            <div className="mt-6">
              <h2 className="text-sm font-medium text-amber-600 dark:text-amber-400">
                Review Queue ({feedback.filter(f => f.status === "pending").length})
              </h2>
              <p className="mt-0.5 text-xs text-zinc-400">Agent feedback on smart tags — review and apply pattern improvements.</p>
              <div className="mt-3 space-y-2">
                {feedback.filter(f => f.status === "pending").map(f => (
                  <div key={f.id} className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[9px] font-medium text-violet-600 dark:bg-violet-900/30 dark:text-violet-400">
                          {f.tag_removed.startsWith("smart:") ? f.tag_removed.slice(6) : f.tag_removed}
                        </span>
                        <span className="text-[10px] text-zinc-400">removed by agent</span>
                      </div>
                      <span className="text-[9px] text-zinc-400">{new Date(f.created_at).toLocaleDateString()}</span>
                    </div>
                    {f.agent_reason && (
                      <p className="mt-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                        Agent: &ldquo;{f.agent_reason}&rdquo;
                      </p>
                    )}
                    {f.ai_analysis && (
                      <div className="mt-2 rounded bg-white p-2 text-xs dark:bg-zinc-800">
                        <p className="font-medium text-zinc-700 dark:text-zinc-300">
                          AI Assessment: <span className="capitalize">{f.ai_analysis.assessment.replace(/_/g, " ")}</span>
                        </p>
                        <p className="mt-0.5 text-zinc-500">{f.ai_analysis.explanation}</p>
                        {f.ai_analysis.phrase_to_remove && (
                          <p className="mt-1 text-zinc-500">Suggested remove: <span className="font-mono text-red-500">&ldquo;{f.ai_analysis.phrase_to_remove}&rdquo;</span></p>
                        )}
                        {f.ai_analysis.suggested_negative && (
                          <p className="text-zinc-500">Suggested negative: <span className="font-mono text-emerald-500">&ldquo;{f.ai_analysis.suggested_negative}&rdquo;</span></p>
                        )}
                      </div>
                    )}
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={async () => {
                          await fetch(`/api/workspaces/${workspace.id}/pattern-feedback/${f.id}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ status: "applied" }),
                          });
                          setFeedback(prev => prev.map(fb => fb.id === f.id ? { ...fb, status: "applied" } : fb));
                        }}
                        className="rounded bg-emerald-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-emerald-500"
                      >
                        Mark Applied
                      </button>
                      <button
                        onClick={async () => {
                          await fetch(`/api/workspaces/${workspace.id}/pattern-feedback/${f.id}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ status: "dismissed" }),
                          });
                          setFeedback(prev => prev.map(fb => fb.id === f.id ? { ...fb, status: "dismissed" } : fb));
                        }}
                        className="text-[10px] text-zinc-500 hover:text-zinc-700"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-8">
            <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Global Pattern Library</h2>
            <p className="mt-0.5 text-xs text-zinc-400">Built-in patterns that ship with ShopCX. Enable or dismiss per workspace.</p>
            <div className="mt-3 space-y-2">
              {globalPatterns.length === 0 ? (
                <p className="py-4 text-center text-sm text-zinc-400">No global patterns.</p>
              ) : (
                globalPatterns.map(p => (
                  <div key={p.id} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{p.name}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[9px] font-medium ${CATEGORY_COLORS[p.category] || CATEGORY_COLORS.custom}`}>
                          {p.category.replace(/_/g, " ")}
                        </span>
                        {p.auto_tag && (
                          <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[9px] text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">
                            tag: {p.auto_tag}
                          </span>
                        )}
                        <span className="text-[9px] text-zinc-400">
                          {(p.phrases || []).length} phrases | priority {p.priority}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-zinc-400">
                        {(p.phrases || []).slice(0, 5).join(", ")}{(p.phrases || []).length > 5 ? "..." : ""}
                      </p>
                    </div>
                    <button
                      onClick={() => handleToggleGlobal(p.id, p.workspace_enabled)}
                      className={`ml-4 shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                        p.workspace_enabled
                          ? "bg-emerald-100 text-emerald-600 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400"
                          : "bg-zinc-100 text-zinc-400 hover:bg-zinc-200 dark:bg-zinc-800"
                      }`}
                    >
                      {p.workspace_enabled ? "Enabled" : "Dismissed"}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Workspace Patterns */}
          <div className="mt-8">
            <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Workspace Patterns</h2>
            <p className="mt-0.5 text-xs text-zinc-400">Custom patterns specific to your workspace.</p>
            <div className="mt-3 space-y-2">
              {workspacePatterns.length === 0 ? (
                <p className="py-4 text-center text-sm text-zinc-400">No custom patterns yet.</p>
              ) : (
                workspacePatterns.map(p => (
                  <div key={p.id} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{p.name}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[9px] font-medium ${CATEGORY_COLORS[p.category] || CATEGORY_COLORS.custom}`}>
                          {p.category.replace(/_/g, " ")}
                        </span>
                        {p.auto_tag && (
                          <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[9px] text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">
                            tag: {p.auto_tag}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-zinc-400">
                        {(p.phrases || []).slice(0, 5).join(", ")}
                      </p>
                    </div>
                    <div className="ml-4 flex items-center gap-2">
                      <button
                        onClick={() => {
                          setIsNew(false);
                          setEditing({
                            id: p.id,
                            name: p.name,
                            category: p.category,
                            phrases: (p.phrases || []).join("\n"),
                            match_target: p.match_target,
                            priority: p.priority,
                            auto_tag: p.auto_tag || "",
                          });
                        }}
                        className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        Edit
                      </button>
                      <button onClick={() => handleDelete(p.id)} className="text-xs text-red-500 hover:underline">
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
