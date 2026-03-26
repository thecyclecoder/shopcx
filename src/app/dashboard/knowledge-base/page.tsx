"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Article {
  id: string;
  title: string;
  content: string;
  content_html: string | null;
  category: string;
  slug: string | null;
  published: boolean;
  product_id: string | null;
  product_name: string | null;
  source: string;
  excerpt: string | null;
  created_at: string;
}

interface Product {
  id: string;
  title: string;
}

const CATEGORIES = ["product", "policy", "shipping", "billing", "general", "faq", "troubleshooting"];

export default function KnowledgeBasePage() {
  const workspace = useWorkspace();
  const [articles, setArticles] = useState<Article[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<Article> | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [productFilter, setProductFilter] = useState("");
  const [helpSlug, setHelpSlug] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch(`/api/workspaces/${workspace.id}/knowledge-base`).then(r => r.json()),
      fetch(`/api/workspaces/${workspace.id}/products`).then(r => r.json()).catch(() => []),
      fetch(`/api/workspaces/${workspace.id}/integrations`).then(r => r.json()).catch(() => ({})),
    ]).then(([a, p, integrations]) => {
      if (Array.isArray(a)) setArticles(a);
      if (Array.isArray(p)) setProducts(p);
      if (integrations.help_slug) setHelpSlug(integrations.help_slug);
    }).finally(() => setLoading(false));
  }, [workspace.id]);

  const filtered = articles.filter(a => {
    if (categoryFilter && a.category !== categoryFilter) return false;
    if (productFilter && a.product_id !== productFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return a.title.toLowerCase().includes(q) || a.content.toLowerCase().includes(q);
  });

  const handleSave = async () => {
    if (!editing?.title || !editing?.content) return;
    setSaving(true);
    const base = `/api/workspaces/${workspace.id}/knowledge-base`;
    const isNew = !editing.id;

    // Auto-generate slug from title if not set
    if (!editing.slug && editing.title) {
      editing.slug = editing.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    }

    const res = await fetch(isNew ? base : `${base}/${editing.id}`, {
      method: isNew ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editing),
    });

    if (res.ok) {
      const saved = await res.json();
      if (isNew) setArticles(prev => [saved, ...prev]);
      else setArticles(prev => prev.map(a => a.id === saved.id ? saved : a));
      setEditingId(null);
      setEditing(null);
    }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this article?")) return;
    await fetch(`/api/workspaces/${workspace.id}/knowledge-base/${id}`, { method: "DELETE" });
    setArticles(prev => prev.filter(a => a.id !== id));
  };

  if (loading) return <div className="p-8 text-sm text-zinc-400">Loading...</div>;

  const publishedCount = articles.filter(a => a.published).length;

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Knowledge Base</h1>
          <p className="mt-1 text-sm text-zinc-500">{articles.length} articles ({publishedCount} published)</p>
        </div>
        <div className="flex items-center gap-2">
          {helpSlug && (
            <a
              href={`https://${helpSlug}.shopcx.ai`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              View Help Center
            </a>
          )}
          <button
            onClick={() => {
              setEditingId("new");
              setEditing({ title: "", content: "", category: "general", published: false, product_id: null });
            }}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            New Article
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="mt-4 flex gap-3">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search articles..."
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
          <option value="">All categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        {products.length > 0 && (
          <select value={productFilter} onChange={(e) => setProductFilter(e.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
            <option value="">All products</option>
            {products.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        )}
      </div>

      {/* New article form */}
      {editingId === "new" && editing && (
        <div className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-950">
          <ArticleForm article={editing} products={products} saving={saving}
            onChange={setEditing} onSave={handleSave} onCancel={() => { setEditingId(null); setEditing(null); }} />
        </div>
      )}

      {/* Article list */}
      <div className="mt-4 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
        {filtered.length === 0 && <p className="p-4 text-sm text-zinc-400">No articles found.</p>}
        {filtered.map(a => (
          <div key={a.id}>
            <div className="flex items-center justify-between p-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{a.title}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${a.published ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400" : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800"}`}>
                    {a.published ? "Published" : "Draft"}
                  </span>
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800">{a.category}</span>
                  {a.source !== "manual" && <span className="text-xs text-zinc-400">via {a.source}</span>}
                </div>
                <p className="mt-1 truncate text-xs text-zinc-500">{a.excerpt || a.content.slice(0, 120)}</p>
              </div>
              <div className="ml-3 flex shrink-0 items-center gap-2">
                <button
                  onClick={() => {
                    if (editingId === a.id) { setEditingId(null); setEditing(null); }
                    else { setEditingId(a.id); setEditing(a); }
                  }}
                  className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {editingId === a.id ? "Close" : "Edit"}
                </button>
                <button onClick={() => handleDelete(a.id)} className="text-xs text-red-500 hover:underline">Delete</button>
              </div>
            </div>
            {editingId === a.id && editing && (
              <div className="border-t border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-950">
                <ArticleForm article={editing} products={products} saving={saving}
                  onChange={setEditing} onSave={handleSave} onCancel={() => { setEditingId(null); setEditing(null); }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ArticleForm({ article, products, saving, onChange, onSave, onCancel }: {
  article: Partial<Article>;
  products: Product[];
  saving: boolean;
  onChange: (a: Partial<Article>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3">
      <input type="text" value={article.title || ""} onChange={(e) => onChange({ ...article, title: e.target.value })}
        placeholder="Article title" className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
      <div className="flex gap-3">
        <select value={article.category || "general"} onChange={(e) => onChange({ ...article, category: e.target.value })}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
          {["product", "policy", "shipping", "billing", "general", "faq", "troubleshooting"].map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={article.product_id || ""} onChange={(e) => onChange({ ...article, product_id: e.target.value || null })}
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
          <option value="">No product</option>
          {products.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
      </div>
      <div className="flex gap-3">
        <input type="text" value={article.slug || ""} onChange={(e) => onChange({ ...article, slug: e.target.value })}
          placeholder="URL slug (auto-generated)" className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
        <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={article.published || false} onChange={(e) => onChange({ ...article, published: e.target.checked })}
            className="h-4 w-4 rounded border-zinc-300 text-emerald-600" />
          Published
        </label>
      </div>
      <textarea value={article.content || ""} onChange={(e) => onChange({ ...article, content: e.target.value })}
        placeholder="Article content..." rows={10} className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
      <div className="flex gap-2">
        <button onClick={onSave} disabled={saving} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{saving ? "Saving..." : "Save"}</button>
        <button onClick={onCancel} className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">Cancel</button>
      </div>
    </div>
  );
}
