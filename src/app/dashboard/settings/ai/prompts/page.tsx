"use client";

import { useState, useEffect, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Prompt {
  id: string;
  category: string;
  title: string;
  content: string;
  enabled: boolean;
  sort_order: number;
}

const CATEGORIES = [
  { value: "rule", label: "Rule", description: "Routing rules (e.g. cancel → journey)" },
  { value: "approach", label: "Approach", description: "How Sonnet reasons about requests" },
  { value: "knowledge", label: "Knowledge", description: "Additional context Sonnet should know" },
  { value: "tool_hint", label: "Tool Hint", description: "Hints about when to use specific tools" },
];

export default function SonnetPromptsPage() {
  const workspace = useWorkspace();
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newPrompt, setNewPrompt] = useState({ category: "rule", title: "", content: "" });

  const fetch_ = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/sonnet-prompts`);
    if (res.ok) {
      const data = await res.json();
      setPrompts(data.prompts || []);
    }
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => { fetch_(); }, [fetch_]);

  const handleAdd = async () => {
    if (!newPrompt.title.trim() || !newPrompt.content.trim()) return;
    const res = await fetch(`/api/workspaces/${workspace.id}/sonnet-prompts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...newPrompt, sort_order: prompts.length }),
    });
    if (res.ok) {
      setAdding(false);
      setNewPrompt({ category: "rule", title: "", content: "" });
      fetch_();
    }
  };

  const handleUpdate = async (id: string, updates: Partial<Prompt>) => {
    await fetch(`/api/workspaces/${workspace.id}/sonnet-prompts`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...updates }),
    });
    fetch_();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this prompt?")) return;
    await fetch(`/api/workspaces/${workspace.id}/sonnet-prompts?id=${id}`, { method: "DELETE" });
    fetch_();
  };

  const handleToggle = (id: string, enabled: boolean) => handleUpdate(id, { enabled: !enabled });

  if (loading) return <div className="p-8"><p className="text-zinc-500">Loading...</p></div>;

  const grouped = CATEGORIES.map(cat => ({
    ...cat,
    prompts: prompts.filter(p => p.category === cat.value),
  }));

  return (
    <div className="px-4 py-6 sm:p-8">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">AI Agent Prompts</h1>
          <p className="mt-1 text-sm text-zinc-500">Train the Sonnet orchestrator with custom rules, approaches, and knowledge. Changes take effect immediately.</p>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          Add Prompt
        </button>
      </div>

      {adding && (
        <div className="mb-6 rounded-lg border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-950">
          <h3 className="mb-3 text-sm font-medium text-indigo-700 dark:text-indigo-300">New Prompt</h3>
          <div className="space-y-3">
            <div className="flex gap-3">
              <select
                value={newPrompt.category}
                onChange={e => setNewPrompt({ ...newPrompt, category: e.target.value })}
                className="rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800"
              >
                {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
              <input
                type="text"
                placeholder="Title (e.g. 'Handle returns')"
                value={newPrompt.title}
                onChange={e => setNewPrompt({ ...newPrompt, title: e.target.value })}
                className="flex-1 rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
            </div>
            <textarea
              placeholder="Prompt content — this gets injected into Sonnet's instructions..."
              value={newPrompt.content}
              onChange={e => setNewPrompt({ ...newPrompt, content: e.target.value })}
              rows={3}
              className="w-full rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <div className="flex gap-2">
              <button onClick={handleAdd} className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">Save</button>
              <button onClick={() => setAdding(false)} className="rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {grouped.map(cat => (
        <div key={cat.value} className="mb-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-zinc-500">{cat.label}s</h2>
          <p className="mb-3 text-xs text-zinc-400">{cat.description}</p>

          {cat.prompts.length === 0 && (
            <p className="text-xs text-zinc-400 italic">No {cat.label.toLowerCase()}s configured</p>
          )}

          <div className="space-y-2">
            {cat.prompts.map(p => (
              <div key={p.id} className={`rounded-lg border p-3 ${p.enabled ? "border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900" : "border-zinc-100 bg-zinc-50 opacity-50 dark:border-zinc-800 dark:bg-zinc-950"}`}>
                {editing === p.id ? (
                  <EditForm
                    prompt={p}
                    onSave={(updates) => { handleUpdate(p.id, updates); setEditing(null); }}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{p.title}</p>
                      <p className="mt-0.5 text-xs text-zinc-500 line-clamp-2">{p.content}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        onClick={() => handleToggle(p.id, p.enabled)}
                        className={`rounded px-2 py-0.5 text-xs font-medium ${p.enabled ? "bg-green-100 text-green-700" : "bg-zinc-100 text-zinc-500"}`}
                      >
                        {p.enabled ? "On" : "Off"}
                      </button>
                      <button onClick={() => setEditing(p.id)} className="text-xs text-indigo-600 hover:underline">Edit</button>
                      <button onClick={() => handleDelete(p.id)} className="text-xs text-red-500 hover:underline">Delete</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function EditForm({ prompt, onSave, onCancel }: { prompt: Prompt; onSave: (u: Partial<Prompt>) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(prompt.title);
  const [content, setContent] = useState(prompt.content);
  const [category, setCategory] = useState(prompt.category);

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <select value={category} onChange={e => setCategory(e.target.value)} className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800">
          {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <input type="text" value={title} onChange={e => setTitle(e.target.value)} className="flex-1 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
      </div>
      <textarea value={content} onChange={e => setContent(e.target.value)} rows={3} className="w-full rounded border border-zinc-300 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
      <div className="flex gap-2">
        <button onClick={() => onSave({ title, content, category })} className="rounded bg-indigo-600 px-2 py-1 text-xs text-white">Save</button>
        <button onClick={onCancel} className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700">Cancel</button>
      </div>
    </div>
  );
}
