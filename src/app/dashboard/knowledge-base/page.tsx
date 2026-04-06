"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  view_count: number;
  helpful_yes: number;
  helpful_no: number;
  created_at: string;
  updated_at: string;
}

const PAGE_SIZE = 25;

const CATEGORIES = ["product", "policy", "shipping", "billing", "general", "faq", "troubleshooting"];

function formatDate(d: string | null): string {
  if (!d) return "--";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function KnowledgeBasePage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [helpSlug, setHelpSlug] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState("updated_at");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);

  // If ?generate= param exists, redirect to new article page
  useEffect(() => {
    const generateQuery = searchParams.get("generate");
    if (generateQuery) {
      router.push(`/dashboard/knowledge-base/new?generate=${encodeURIComponent(generateQuery)}`);
    }
  }, [searchParams, router]);

  // Fetch help slug once
  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/integrations`)
      .then(r => r.json())
      .then(data => { if (data.help_slug) setHelpSlug(data.help_slug); })
      .catch(() => {});
  }, [workspace.id]);

  const fetchArticles = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/knowledge-base`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) setArticles(data);
    }
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => { fetchArticles(); }, [fetchArticles]);

  // Client-side filter, sort, paginate
  const filtered = articles.filter(a => {
    if (categoryFilter !== "all" && a.category !== categoryFilter) return false;
    if (statusFilter === "published" && !a.published) return false;
    if (statusFilter === "draft" && a.published) return false;
    if (!appliedSearch.trim()) return true;
    const q = appliedSearch.toLowerCase();
    return a.title.toLowerCase().includes(q) || a.content.toLowerCase().includes(q);
  });

  const sorted = [...filtered].sort((a, b) => {
    let aVal: string | number = "";
    let bVal: string | number = "";
    if (sort === "title") { aVal = a.title.toLowerCase(); bVal = b.title.toLowerCase(); }
    else if (sort === "category") { aVal = a.category; bVal = b.category; }
    else if (sort === "published") { aVal = a.published ? 1 : 0; bVal = b.published ? 1 : 0; }
    else if (sort === "view_count") { aVal = a.view_count || 0; bVal = b.view_count || 0; }
    else if (sort === "helpful") { aVal = (a.helpful_yes || 0) - (a.helpful_no || 0); bVal = (b.helpful_yes || 0) - (b.helpful_no || 0); }
    else if (sort === "updated_at") { aVal = a.updated_at || a.created_at; bVal = b.updated_at || b.created_at; }
    if (aVal < bVal) return order === "asc" ? -1 : 1;
    if (aVal > bVal) return order === "asc" ? 1 : -1;
    return 0;
  });

  const total = sorted.length;
  const page = sorted.slice(offset, offset + PAGE_SIZE);

  const handleSort = (col: string) => {
    if (sort === col) setOrder(o => o === "asc" ? "desc" : "asc");
    else { setSort(col); setOrder(col === "updated_at" ? "desc" : "asc"); }
    setOffset(0);
  };

  const SortIcon = ({ col }: { col: string }) => (
    sort === col ? <span className="ml-1 text-[10px]">{order === "asc" ? "\u25B2" : "\u25BC"}</span> : null
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Articles</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {articles.length} articles ({articles.filter(a => a.published).length} published)
          </p>
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
            onClick={() => router.push("/dashboard/knowledge-base/new")}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            New Article
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select value={categoryFilter} onChange={e => { setCategoryFilter(e.target.value); setOffset(0); }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          <option value="all">All Categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
        </select>

        <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setOffset(0); }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          <option value="all">All Statuses</option>
          <option value="published">Published</option>
          <option value="draft">Draft</option>
        </select>

        <form onSubmit={e => { e.preventDefault(); setAppliedSearch(search); setOffset(0); }} className="flex gap-1">
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search articles..."
            className="w-56 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" />
          <button type="submit" className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm dark:bg-zinc-700 dark:text-zinc-300">Go</button>
        </form>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase text-zinc-400 dark:border-zinc-800">
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("title")}>Title<SortIcon col="title" /></th>
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("category")}>Category<SortIcon col="category" /></th>
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("published")}>Status<SortIcon col="published" /></th>
                <th className="cursor-pointer px-4 py-2.5 text-right" onClick={() => handleSort("view_count")}>Views<SortIcon col="view_count" /></th>
                <th className="cursor-pointer px-4 py-2.5 text-right" onClick={() => handleSort("helpful")}>Helpful<SortIcon col="helpful" /></th>
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("updated_at")}>Updated<SortIcon col="updated_at" /></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-zinc-400">Loading...</td></tr>
              ) : page.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-zinc-400">No articles found</td></tr>
              ) : page.map(a => (
                <tr key={a.id}
                  onClick={() => router.push(`/dashboard/knowledge-base/${a.id}`)}
                  className="cursor-pointer border-b border-zinc-50 transition-colors hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/30">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">{a.title}</div>
                    {a.excerpt && <div className="mt-0.5 max-w-md truncate text-xs text-zinc-400">{a.excerpt}</div>}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      {a.category}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                      a.published
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                        : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                    }`}>
                      {a.published ? "Published" : "Draft"}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-zinc-500">
                    {a.view_count || 0}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-zinc-500">
                    <span className="text-emerald-600">{a.helpful_yes || 0}</span>
                    {" / "}
                    <span className="text-red-500">{a.helpful_no || 0}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-zinc-400">{formatDate(a.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
            <p className="text-xs text-zinc-500">{offset + 1}--{Math.min(offset + PAGE_SIZE, total)} of {total}</p>
            <div className="flex gap-2">
              <button onClick={() => setOffset(o => Math.max(0, o - PAGE_SIZE))} disabled={offset === 0}
                className="rounded-md border border-zinc-300 px-3 py-1 text-xs disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300">Previous</button>
              <button onClick={() => setOffset(o => o + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total}
                className="rounded-md border border-zinc-300 px-3 py-1 text-xs disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
