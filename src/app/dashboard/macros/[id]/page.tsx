"use client";

import { useEffect, useState, useCallback, use } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface Macro {
  id: string;
  name: string;
  body_text: string;
  body_html: string | null;
  category: string;
  tags: string[];
  active: boolean;
  product_id: string | null;
  usage_count: number;
  ai_suggest_count: number;
  ai_accept_count: number;
  ai_reject_count: number;
  ai_edit_count: number;
  created_at: string;
  updated_at: string;
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

function formatDate(d: string | null): string {
  if (!d) return "--";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function MacroDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: macroId } = use(params);
  const workspace = useWorkspace();
  const router = useRouter();

  const isNew = macroId === "new";

  const [macro, setMacro] = useState<Macro | null>(
    isNew
      ? {
          id: "",
          name: "",
          body_text: "",
          body_html: null,
          category: "general",
          tags: [],
          active: true,
          product_id: null,
          usage_count: 0,
          ai_suggest_count: 0,
          ai_accept_count: 0,
          ai_reject_count: 0,
          ai_edit_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
      : null
  );
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [products, setProducts] = useState<{ id: string; title: string }[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [dirty, setDirty] = useState(false);

  const fetchMacro = useCallback(async () => {
    if (isNew) return;
    setLoading(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/macros/${macroId}`);
    if (res.ok) {
      setMacro(await res.json());
    } else {
      router.push("/dashboard/macros");
    }
    setLoading(false);
  }, [workspace.id, macroId, isNew, router]);

  useEffect(() => {
    fetchMacro();
    fetch(`/api/workspaces/${workspace.id}/products`)
      .then(r => r.ok ? r.json() : [])
      .then(d => setProducts(Array.isArray(d) ? d.map((p: { id: string; title: string }) => ({ id: p.id, title: p.title })) : []))
      .catch(() => {});
  }, [fetchMacro, workspace.id]);

  const updateField = <K extends keyof Macro>(field: K, value: Macro[K]) => {
    if (!macro) return;
    setMacro({ ...macro, [field]: value });
    setDirty(true);
  };

  const handleSave = async () => {
    if (!macro || !macro.name.trim() || !macro.body_text.trim()) return;
    setSaving(true);

    const base = `/api/workspaces/${workspace.id}/macros`;
    const payload = {
      name: macro.name,
      body_text: macro.body_text,
      body_html: macro.body_html,
      category: macro.category,
      tags: macro.tags,
      active: macro.active,
      product_id: macro.product_id,
    };

    const res = await fetch(isNew ? base : `${base}/${macroId}`, {
      method: isNew ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      const saved = await res.json();
      if (isNew) {
        router.push(`/dashboard/macros/${saved.id}`);
      } else {
        setMacro(saved);
        setDirty(false);
      }
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!confirm("Delete this macro? This cannot be undone.")) return;
    setDeleting(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/macros/${macroId}`, { method: "DELETE" });
    if (res.ok) {
      router.push("/dashboard/macros");
    }
    setDeleting(false);
  };

  if (loading) {
    return <div className="p-8 text-sm text-zinc-400">Loading...</div>;
  }

  if (!macro) {
    return <div className="p-8 text-sm text-zinc-400">Macro not found</div>;
  }

  const ar =
    macro.ai_suggest_count > 0
      ? (() => {
          const rate = macro.ai_accept_count / macro.ai_suggest_count;
          const pct = Math.round(rate * 100);
          if (rate >= 0.7) return { pct, classes: "text-emerald-600 dark:text-emerald-400" };
          if (rate >= 0.4) return { pct, classes: "text-amber-600 dark:text-amber-400" };
          return { pct, classes: "text-red-600 dark:text-red-400" };
        })()
      : null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      {/* Back link */}
      <button
        onClick={() => router.push("/dashboard/macros")}
        className="mb-4 text-sm text-indigo-600 hover:underline dark:text-indigo-400"
      >
        &larr; Back to Macros
      </button>

      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            {isNew ? "New Macro" : macro.name}
          </h1>
          {!isNew && (
            <button
              onClick={() => updateField("active", !macro.active)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                macro.active ? "bg-indigo-600" : "bg-zinc-300 dark:bg-zinc-600"
              }`}
              title={macro.active ? "Active" : "Inactive"}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  macro.active ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          )}
        </div>
        <div className="flex gap-2">
          {!isNew && (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
            >
              {deleting ? "Deleting..." : "Delete"}
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saving || (!dirty && !isNew)}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main content - 2 cols */}
        <div className="space-y-4 lg:col-span-2">
          {/* Name */}
          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Name</label>
            <input
              type="text"
              value={macro.name}
              onChange={e => updateField("name", e.target.value)}
              placeholder="Macro name"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
          </div>

          {/* Rich Text Editor */}
          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Content</label>
            {/* Toolbar */}
            <div className="flex gap-1 rounded-t-md border border-b-0 border-zinc-300 bg-zinc-50 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-800">
              <button type="button" onClick={() => document.execCommand("bold")} className="rounded px-2 py-1 text-xs font-bold text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-700" title="Bold">B</button>
              <button type="button" onClick={() => document.execCommand("italic")} className="rounded px-2 py-1 text-xs italic text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-700" title="Italic">I</button>
              <button type="button" onClick={() => document.execCommand("underline")} className="rounded px-2 py-1 text-xs underline text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-700" title="Underline">U</button>
              <span className="mx-1 border-l border-zinc-300 dark:border-zinc-600" />
              <button type="button" onClick={() => {
                const url = prompt("Enter URL:");
                if (url) document.execCommand("createLink", false, url);
              }} className="rounded px-2 py-1 text-xs text-indigo-500 hover:bg-zinc-200 dark:hover:bg-zinc-700" title="Insert Link">Link</button>
              <button type="button" onClick={() => document.execCommand("unlink")} className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700" title="Remove Link">Unlink</button>
              <span className="mx-1 border-l border-zinc-300 dark:border-zinc-600" />
              <button type="button" onClick={() => document.execCommand("insertUnorderedList")} className="rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-700" title="Bullet List">List</button>
            </div>
            {/* Editable area */}
            <div
              contentEditable
              suppressContentEditableWarning
              className="min-h-[200px] rounded-b-md border border-zinc-300 bg-white px-4 py-3 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 prose prose-sm max-w-none dark:prose-invert [&_a]:text-indigo-600 [&_a]:underline dark:[&_a]:text-indigo-400 [&_p]:mb-3"
              dangerouslySetInnerHTML={{ __html: macro.body_html || macro.body_text.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>").replace(/^/, "<p>").replace(/$/, "</p>") }}
              onBlur={(e) => {
                const html = e.currentTarget.innerHTML;
                const text = e.currentTarget.innerText;
                updateField("body_html", html);
                updateField("body_text", text);
              }}
            />
          </div>
        </div>

        {/* Sidebar - 1 col */}
        <div className="space-y-4">
          {/* Category */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Category</label>
            <select
              value={macro.category || "general"}
              onChange={e => updateField("category", e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              {CATEGORIES.map(c => (
                <option key={c} value={c}>
                  {c.charAt(0).toUpperCase() + c.slice(1)}
                </option>
              ))}
            </select>
            {macro.category && (
              <span
                className={`mt-2 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${CATEGORY_COLORS[macro.category] || CATEGORY_COLORS.general}`}
              >
                {macro.category}
              </span>
            )}
          </div>

          {/* Product */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Product</label>
            <select
              value={macro.product_id || ""}
              onChange={e => updateField("product_id", e.target.value || null)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="">No product</option>
              {products.map(p => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
          </div>

          {/* Usage Stats */}
          {!isNew && (
            <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">Usage Stats</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Manual uses</span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{macro.usage_count}</span>
                </div>
                <div className="my-2 border-t border-zinc-100 dark:border-zinc-800" />
                <div className="flex justify-between">
                  <span className="text-zinc-500">AI suggested</span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{macro.ai_suggest_count}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Accepted</span>
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">{macro.ai_accept_count}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Rejected</span>
                  <span className="font-medium text-red-500">{macro.ai_reject_count}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Edited</span>
                  <span className="font-medium text-amber-500">{macro.ai_edit_count}</span>
                </div>
                {ar && (
                  <>
                    <div className="my-2 border-t border-zinc-100 dark:border-zinc-800" />
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Acceptance rate</span>
                      <span className={`font-semibold ${ar.classes}`}>{ar.pct}%</span>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Dates */}
          {!isNew && (
            <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">Dates</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Created</span>
                  <span className="text-zinc-700 dark:text-zinc-300">{formatDate(macro.created_at)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Updated</span>
                  <span className="text-zinc-700 dark:text-zinc-300">{formatDate(macro.updated_at)}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
