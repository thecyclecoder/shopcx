"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import Link from "next/link";

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
  view_count: number;
  helpful_yes: number;
  helpful_no: number;
  created_at: string;
  updated_at: string;
}

interface Product {
  id: string;
  title: string;
}

const CATEGORIES = ["product", "policy", "shipping", "billing", "general", "faq", "troubleshooting"];

function formatDate(d: string | null): string {
  if (!d) return "--";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export default function KnowledgeBaseDetailPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const params = useParams();
  const articleId = params.id as string;
  const isNew = articleId === "new";

  const [article, setArticle] = useState<Partial<Article>>({
    title: "",
    content: "",
    content_html: "",
    category: "general",
    slug: "",
    published: false,
    product_id: null,
  });
  const [products, setProducts] = useState<Product[]>([]);
  const [productSearch, setProductSearch] = useState("");
  const [showProductDropdown, setShowProductDropdown] = useState(false);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const editorRef = useRef<HTMLDivElement>(null);
  const editorInitialized = useRef(false);
  const productDropdownRef = useRef<HTMLDivElement>(null);

  // Fetch article data
  const fetchArticle = useCallback(async () => {
    if (isNew) return;
    setLoading(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/knowledge-base/${articleId}`);
    if (res.ok) {
      const data = await res.json();
      setArticle(data);
      if (data.slug) setSlugManuallyEdited(true);
    } else {
      router.push("/dashboard/knowledge-base");
    }
    setLoading(false);
  }, [workspace.id, articleId, isNew, router]);

  // Fetch products
  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/products`)
      .then(r => r.ok ? r.json() : [])
      .then(setProducts)
      .catch(() => {});
  }, [workspace.id]);

  useEffect(() => { fetchArticle(); }, [fetchArticle]);

  // Initialize editor content after article loads
  useEffect(() => {
    if (editorRef.current && !editorInitialized.current && (article.content_html || article.content || isNew)) {
      editorRef.current.innerHTML = article.content_html || article.content || "";
      editorInitialized.current = true;
    }
  }, [article.content_html, article.content, isNew]);

  // Close product dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (productDropdownRef.current && !productDropdownRef.current.contains(e.target as Node)) {
        setShowProductDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const syncContent = () => {
    if (!editorRef.current) return;
    const html = editorRef.current.innerHTML;
    const text = editorRef.current.innerText || "";
    setArticle(prev => ({ ...prev, content: text, content_html: html }));
  };

  const handleTitleChange = (title: string) => {
    setArticle(prev => {
      const updates: Partial<Article> = { ...prev, title };
      if (!slugManuallyEdited) {
        updates.slug = slugify(title);
      }
      return updates;
    });
  };

  const handleSave = async () => {
    if (!article.title?.trim()) return;
    syncContent();
    setSaving(true);
    setSaveMessage(null);

    const html = editorRef.current?.innerHTML || article.content_html || "";
    const text = editorRef.current?.innerText || article.content || "";

    const payload = {
      title: article.title,
      content: text,
      content_html: html,
      category: article.category || "general",
      slug: article.slug || slugify(article.title || ""),
      published: article.published,
      product_id: article.product_id || null,
      excerpt: text.slice(0, 200),
    };

    const base = `/api/workspaces/${workspace.id}/knowledge-base`;

    if (isNew) {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const saved = await res.json();
        router.push(`/dashboard/knowledge-base/${saved.id}`);
      }
    } else {
      const res = await fetch(`${base}/${articleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const saved = await res.json();
        setArticle(saved);
        setSaveMessage("Saved");
        setTimeout(() => setSaveMessage(null), 2000);
      }
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!confirm("Delete this article? This cannot be undone.")) return;
    setDeleting(true);
    await fetch(`/api/workspaces/${workspace.id}/knowledge-base/${articleId}`, { method: "DELETE" });
    router.push("/dashboard/knowledge-base");
  };

  const filteredProducts = products.filter(p =>
    !productSearch.trim() || p.title.toLowerCase().includes(productSearch.toLowerCase())
  );

  const selectedProduct = products.find(p => p.id === article.product_id);

  if (loading) return <div className="p-8 text-sm text-zinc-400">Loading...</div>;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Back link */}
      <Link href="/dashboard/knowledge-base" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
        Back to Articles
      </Link>

      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex-1">
          <input
            type="text"
            value={article.title || ""}
            onChange={e => handleTitleChange(e.target.value)}
            placeholder="Article title"
            className="w-full border-0 bg-transparent text-2xl font-bold text-zinc-900 outline-none placeholder:text-zinc-300 dark:text-zinc-100 dark:placeholder:text-zinc-600"
          />
        </div>
        <div className="flex items-center gap-2">
          {saveMessage && <span className="text-sm text-emerald-600">{saveMessage}</span>}
          <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={article.published || false}
              onChange={e => setArticle(prev => ({ ...prev, published: e.target.checked }))}
              className="h-4 w-4 rounded border-zinc-300 text-emerald-600"
            />
            Published
          </label>
          <button
            onClick={handleSave}
            disabled={saving || !article.title?.trim()}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          {!isNew && (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20"
            >
              {deleting ? "Deleting..." : "Delete"}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        {/* Main content - Editor */}
        <div>
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-700">
            {/* Toolbar */}
            <div className="flex items-center gap-0.5 border-b border-zinc-200 bg-zinc-50 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-800">
              {[
                { cmd: "bold", icon: "B", cls: "font-bold" },
                { cmd: "italic", icon: "I", cls: "italic" },
                { cmd: "underline", icon: "U", cls: "underline" },
              ].map(({ cmd, icon, cls }) => (
                <button key={cmd} type="button"
                  onMouseDown={(e) => { e.preventDefault(); document.execCommand(cmd); }}
                  className={`rounded px-2 py-0.5 text-sm text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-700 ${cls}`}
                >{icon}</button>
              ))}
              <span className="mx-1 h-4 w-px bg-zinc-300 dark:bg-zinc-600" />
              <button type="button" onMouseDown={(e) => { e.preventDefault(); document.execCommand("formatBlock", false, "h2"); }}
                className="rounded px-2 py-0.5 text-sm font-bold text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-700">H2</button>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); document.execCommand("formatBlock", false, "h3"); }}
                className="rounded px-2 py-0.5 text-sm font-bold text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-700">H3</button>
              <span className="mx-1 h-4 w-px bg-zinc-300 dark:bg-zinc-600" />
              <button type="button" onMouseDown={(e) => { e.preventDefault(); document.execCommand("insertUnorderedList"); }}
                className="rounded px-2 py-0.5 text-sm text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-700">&#8226; List</button>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); document.execCommand("insertOrderedList"); }}
                className="rounded px-2 py-0.5 text-sm text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-700">1. List</button>
              <span className="mx-1 h-4 w-px bg-zinc-300 dark:bg-zinc-600" />
              <button type="button" onMouseDown={(e) => {
                e.preventDefault();
                const url = prompt("Enter URL:");
                if (url) document.execCommand("createLink", false, url);
              }} className="rounded px-2 py-0.5 text-sm text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-700">Link</button>
            </div>
            {/* Editor */}
            <div
              ref={editorRef}
              contentEditable
              onInput={syncContent}
              onBlur={syncContent}
              className="prose prose-sm max-w-none min-h-[500px] bg-white px-4 py-3 text-sm outline-none dark:bg-zinc-900 dark:text-zinc-100 dark:prose-invert"
              data-placeholder="Start writing your article..."
            />
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Category */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <label className="mb-1.5 block text-xs font-medium uppercase text-zinc-400">Category</label>
            <select
              value={article.category || "general"}
              onChange={e => setArticle(prev => ({ ...prev, category: e.target.value }))}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            >
              {CATEGORIES.map(c => (
                <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
              ))}
            </select>
          </div>

          {/* Slug */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <label className="mb-1.5 block text-xs font-medium uppercase text-zinc-400">URL Slug</label>
            <input
              type="text"
              value={article.slug || ""}
              onChange={e => { setArticle(prev => ({ ...prev, slug: e.target.value })); setSlugManuallyEdited(true); }}
              placeholder="auto-generated-from-title"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            />
          </div>

          {/* Product mapping */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900" ref={productDropdownRef}>
            <label className="mb-1.5 block text-xs font-medium uppercase text-zinc-400">Product</label>
            {selectedProduct ? (
              <div className="flex items-center justify-between rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800">
                <span className="truncate text-zinc-700 dark:text-zinc-300">{selectedProduct.title}</span>
                <button
                  onClick={() => setArticle(prev => ({ ...prev, product_id: null, product_name: null }))}
                  className="ml-2 text-xs text-zinc-400 hover:text-red-500"
                >
                  Remove
                </button>
              </div>
            ) : (
              <div className="relative">
                <input
                  type="text"
                  value={productSearch}
                  onChange={e => { setProductSearch(e.target.value); setShowProductDropdown(true); }}
                  onFocus={() => setShowProductDropdown(true)}
                  placeholder="Search products..."
                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                />
                {showProductDropdown && filteredProducts.length > 0 && (
                  <div className="absolute left-0 top-full z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
                    {filteredProducts.slice(0, 20).map(p => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setArticle(prev => ({ ...prev, product_id: p.id, product_name: p.title }));
                          setProductSearch("");
                          setShowProductDropdown(false);
                        }}
                        className="block w-full px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-700/50"
                      >
                        {p.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Stats card - only show for existing articles */}
          {!isNew && (
            <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <label className="mb-3 block text-xs font-medium uppercase text-zinc-400">Stats</label>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-zinc-500">Views</dt>
                  <dd className="font-medium text-zinc-900 dark:text-zinc-100">{article.view_count || 0}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-zinc-500">Helpful</dt>
                  <dd className="font-medium">
                    <span className="text-emerald-600">{article.helpful_yes || 0}</span>
                    {" / "}
                    <span className="text-red-500">{article.helpful_no || 0}</span>
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-zinc-500">Created</dt>
                  <dd className="text-zinc-700 dark:text-zinc-300">{formatDate(article.created_at || null)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-zinc-500">Updated</dt>
                  <dd className="text-zinc-700 dark:text-zinc-300">{formatDate(article.updated_at || null)}</dd>
                </div>
                {article.source && article.source !== "manual" && (
                  <div className="flex justify-between">
                    <dt className="text-zinc-500">Source</dt>
                    <dd className="text-zinc-700 dark:text-zinc-300">{article.source}</dd>
                  </div>
                )}
              </dl>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
