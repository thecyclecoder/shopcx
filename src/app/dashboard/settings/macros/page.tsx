"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Macro {
  id: string;
  name: string;
  body_text: string;
  body_html: string | null;
  category: string;
  product_id: string | null;
  usage_count: number;
  active: boolean;
  ai_suggest_count: number;
  ai_accept_count: number;
  ai_reject_count: number;
}

interface Product {
  id: string;
  title: string;
}

const CATEGORIES = ["product", "policy", "shipping", "billing", "subscription", "general"];
const CATEGORY_COLORS: Record<string, string> = {
  product: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  policy: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  shipping: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  billing: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  subscription: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
  general: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

export default function MacrosPage() {
  const workspace = useWorkspace();
  const [macros, setMacros] = useState<Macro[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingMacro, setEditingMacro] = useState<Partial<Macro> | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");

  useEffect(() => {
    Promise.all([
      fetch(`/api/workspaces/${workspace.id}/macros`).then(r => r.json()),
      fetch(`/api/workspaces/${workspace.id}/products`).then(r => r.json()).catch(() => []),
    ]).then(([m, p]) => {
      if (Array.isArray(m)) setMacros(m);
      if (Array.isArray(p)) setProducts(p);
    }).finally(() => setLoading(false));
  }, [workspace.id]);

  const filtered = macros.filter(m => {
    if (categoryFilter && m.category !== categoryFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return m.name.toLowerCase().includes(q) || m.body_text.toLowerCase().includes(q);
  });

  const handleSave = async () => {
    if (!editingMacro?.name || !editingMacro?.body_text) return;
    setSaving(true);
    const base = `/api/workspaces/${workspace.id}/macros`;
    const isNew = !editingMacro.id;

    const res = await fetch(isNew ? base : `${base}/${editingMacro.id}`, {
      method: isNew ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editingMacro),
    });

    if (res.ok) {
      const saved = await res.json();
      if (isNew) {
        setMacros(prev => [saved, ...prev]);
      } else {
        setMacros(prev => prev.map(m => m.id === saved.id ? saved : m));
      }
      setEditingId(null);
      setEditingMacro(null);
    }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this macro?")) return;
    await fetch(`/api/workspaces/${workspace.id}/macros/${id}`, { method: "DELETE" });
    setMacros(prev => prev.filter(m => m.id !== id));
  };

  if (loading) return <div className="p-8 text-sm text-zinc-400">Loading...</div>;

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Macros</h1>
          <p className="mt-1 text-sm text-zinc-500">{macros.length} saved responses</p>
        </div>
        <button
          onClick={() => {
            setEditingId("new");
            setEditingMacro({ name: "", body_text: "", category: "general", product_id: null });
          }}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          New Macro
        </button>
      </div>

      {/* Filters */}
      <div className="mt-4 flex gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search macros..."
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        >
          <option value="">All categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* New macro form */}
      {editingId === "new" && editingMacro && (
        <div className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-950">
          <MacroForm macro={editingMacro} products={products} saving={saving}
            onChange={setEditingMacro} onSave={handleSave} onCancel={() => { setEditingId(null); setEditingMacro(null); }} />
        </div>
      )}

      {/* Macro list */}
      <div className="mt-4 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
        {filtered.length === 0 && <p className="p-4 text-sm text-zinc-400">No macros found.</p>}
        {filtered.map(m => (
          <div key={m.id}>
            <div className="flex items-center justify-between p-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{m.name}</span>
                  {m.category && (
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CATEGORY_COLORS[m.category] || CATEGORY_COLORS.general}`}>{m.category}</span>
                  )}
                </div>
                <p className="mt-1 truncate text-xs text-zinc-500">{m.body_text.slice(0, 150)}</p>
              </div>
              <div className="ml-3 flex shrink-0 items-center gap-2">
                <span className="text-xs text-zinc-400">{m.usage_count} uses</span>
                {m.ai_suggest_count > 0 && (
                  <span className={`rounded-full px-1.5 py-0.5 text-xs font-medium ${
                    m.ai_suggest_count > 0 && m.ai_accept_count / m.ai_suggest_count >= 0.7
                      ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                      : m.ai_suggest_count > 0 && m.ai_accept_count / m.ai_suggest_count >= 0.4
                        ? "bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400"
                        : "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"
                  }`}>
                    {Math.round((m.ai_accept_count / m.ai_suggest_count) * 100)}% accepted
                  </span>
                )}
                <button
                  onClick={() => {
                    if (editingId === m.id) { setEditingId(null); setEditingMacro(null); }
                    else { setEditingId(m.id); setEditingMacro(m); }
                  }}
                  className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {editingId === m.id ? "Close" : "Edit"}
                </button>
                <button onClick={() => handleDelete(m.id)} className="text-xs text-red-500 hover:underline">Delete</button>
              </div>
            </div>
            {/* Inline edit */}
            {editingId === m.id && editingMacro && (
              <div className="border-t border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-950">
                <MacroForm macro={editingMacro} products={products} saving={saving}
                  onChange={setEditingMacro} onSave={handleSave} onCancel={() => { setEditingId(null); setEditingMacro(null); }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function MacroForm({ macro, products, saving, onChange, onSave, onCancel }: {
  macro: Partial<Macro>;
  products: Product[];
  saving: boolean;
  onChange: (m: Partial<Macro>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3">
      <input type="text" value={macro.name || ""} onChange={(e) => onChange({ ...macro, name: e.target.value })}
        placeholder="Macro name" className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
      <div className="flex gap-3">
        <select value={macro.category || "general"} onChange={(e) => onChange({ ...macro, category: e.target.value })}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={macro.product_id || ""} onChange={(e) => onChange({ ...macro, product_id: e.target.value || null })}
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
          <option value="">No product</option>
          {products.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
      </div>
      <textarea value={macro.body_text || ""} onChange={(e) => onChange({ ...macro, body_text: e.target.value })}
        placeholder="Macro response text..." rows={6} className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
      <div className="flex gap-2">
        <button onClick={onSave} disabled={saving} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{saving ? "Saving..." : "Save"}</button>
        <button onClick={onCancel} className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">Cancel</button>
      </div>
    </div>
  );
}
