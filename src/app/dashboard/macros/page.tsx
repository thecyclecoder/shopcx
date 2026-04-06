"use client";

import { useEffect, useState, useCallback } from "react";
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
  usage_count: number;
  ai_suggest_count: number;
  ai_accept_count: number;
  ai_reject_count: number;
  ai_edit_count: number;
  created_at: string;
  updated_at: string;
}

const PAGE_SIZE = 25;

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
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function acceptanceRate(m: Macro): { rate: number; label: string; classes: string } | null {
  if (m.ai_suggest_count === 0) return null;
  const rate = m.ai_accept_count / m.ai_suggest_count;
  const pct = Math.round(rate * 100);
  if (rate >= 0.7) return { rate, label: `${pct}%`, classes: "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400" };
  if (rate >= 0.4) return { rate, label: `${pct}%`, classes: "bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400" };
  return { rate, label: `${pct}%`, classes: "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400" };
}

export default function MacrosPage() {
  const workspace = useWorkspace();
  const router = useRouter();

  const [macros, setMacros] = useState<Macro[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<{ id: string; title: string }[]>([]);

  // Filters
  const [category, setCategory] = useState("all");
  const [activeFilter, setActiveFilter] = useState("all");
  const [productFilter, setProductFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [sort, setSort] = useState("name");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [offset, setOffset] = useState(0);

  // Load products for filter
  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/products`)
      .then(r => r.ok ? r.json() : [])
      .then(d => setProducts(Array.isArray(d) ? d.map((p: { id: string; title: string }) => ({ id: p.id, title: p.title })) : []))
      .catch(() => {});
  }, [workspace.id]);

  const fetchMacros = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      sort,
      order,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (category !== "all") params.set("category", category);
    if (activeFilter !== "all") params.set("active", activeFilter);
    if (productFilter !== "all") params.set("product_id", productFilter);
    if (appliedSearch) params.set("search", appliedSearch);

    const res = await fetch(`/api/workspaces/${workspace.id}/macros?${params}`);
    if (res.ok) {
      const data = await res.json();
      setMacros(data.macros || []);
      setTotal(data.total || 0);
    }
    setLoading(false);
  }, [workspace.id, category, activeFilter, productFilter, appliedSearch, sort, order, offset]);

  useEffect(() => {
    fetchMacros();
  }, [fetchMacros]);

  const handleSort = (col: string) => {
    if (sort === col) setOrder(o => (o === "asc" ? "desc" : "asc"));
    else {
      setSort(col);
      setOrder("asc");
    }
    setOffset(0);
  };

  const SortIcon = ({ col }: { col: string }) =>
    sort === col ? <span className="ml-1 text-[10px]">{order === "asc" ? "\u25B2" : "\u25BC"}</span> : null;

  const handleToggleActive = async (e: React.MouseEvent, macro: Macro) => {
    e.stopPropagation();
    const res = await fetch(`/api/workspaces/${workspace.id}/macros/${macro.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !macro.active }),
    });
    if (res.ok) {
      setMacros(prev => prev.map(m => (m.id === macro.id ? { ...m, active: !m.active } : m)));
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Macros</h1>
          <p className="mt-1 text-sm text-zinc-500">{total} saved responses</p>
        </div>
        <button
          onClick={() => router.push("/dashboard/macros/new")}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          New Macro
        </button>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={category}
          onChange={e => {
            setCategory(e.target.value);
            setOffset(0);
          }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        >
          <option value="all">All Categories</option>
          {CATEGORIES.map(c => (
            <option key={c} value={c}>
              {c.charAt(0).toUpperCase() + c.slice(1)}
            </option>
          ))}
        </select>

        <select
          value={activeFilter}
          onChange={e => {
            setActiveFilter(e.target.value);
            setOffset(0);
          }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        >
          <option value="all">All Status</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </select>

        <select
          value={productFilter}
          onChange={e => {
            setProductFilter(e.target.value);
            setOffset(0);
          }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        >
          <option value="all">All Products</option>
          {products.map(p => (
            <option key={p.id} value={p.id}>{p.title}</option>
          ))}
        </select>

        <form
          onSubmit={e => {
            e.preventDefault();
            setAppliedSearch(search);
            setOffset(0);
          }}
          className="flex gap-1"
        >
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search macros..."
            className="w-56 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          />
          <button type="submit" className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm dark:bg-zinc-700 dark:text-zinc-300">
            Go
          </button>
        </form>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase text-zinc-400 dark:border-zinc-800">
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("name")}>
                  Name
                  <SortIcon col="name" />
                </th>
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("category")}>
                  Category
                  <SortIcon col="category" />
                </th>
                <th className="px-4 py-2.5">Active</th>
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("usage_count")}>
                  Usage
                  <SortIcon col="usage_count" />
                </th>
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("ai_suggest_count")}>
                  AI Stats
                  <SortIcon col="ai_suggest_count" />
                </th>
                <th className="px-4 py-2.5">Acceptance</th>
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("updated_at")}>
                  Updated
                  <SortIcon col="updated_at" />
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-zinc-400">
                    Loading...
                  </td>
                </tr>
              ) : macros.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-zinc-400">
                    No macros found
                  </td>
                </tr>
              ) : (
                macros.map(macro => {
                  const ar = acceptanceRate(macro);
                  return (
                    <tr
                      key={macro.id}
                      onClick={() => router.push(`/dashboard/macros/${macro.id}`)}
                      className="cursor-pointer border-b border-zinc-50 transition-colors hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/30"
                    >
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-zinc-900 dark:text-zinc-100">{macro.name}</div>
                        <div className="mt-0.5 max-w-xs truncate text-xs text-zinc-400">{macro.body_text.slice(0, 100)}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        {macro.category && (
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${CATEGORY_COLORS[macro.category] || CATEGORY_COLORS.general}`}
                          >
                            {macro.category}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <button
                          onClick={e => handleToggleActive(e, macro)}
                          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                            macro.active ? "bg-indigo-600" : "bg-zinc-300 dark:bg-zinc-600"
                          }`}
                        >
                          <span
                            className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                              macro.active ? "translate-x-4" : "translate-x-0"
                            }`}
                          />
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-zinc-500">{macro.usage_count} uses</td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <div className="flex gap-3 text-xs text-zinc-400">
                          <span title="Suggested">{macro.ai_suggest_count}s</span>
                          <span title="Accepted" className="text-emerald-500">{macro.ai_accept_count}a</span>
                          <span title="Rejected" className="text-red-400">{macro.ai_reject_count}r</span>
                          <span title="Edited" className="text-amber-500">{macro.ai_edit_count}e</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        {ar && (
                          <span className={`inline-flex rounded-full px-1.5 py-0.5 text-xs font-medium ${ar.classes}`}>
                            {ar.label}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-zinc-400">{formatDate(macro.updated_at)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
            <p className="text-xs text-zinc-500">
              {offset + 1}--{Math.min(offset + PAGE_SIZE, total)} of {total}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setOffset(o => Math.max(0, o - PAGE_SIZE))}
                disabled={offset === 0}
                className="rounded-md border border-zinc-300 px-3 py-1 text-xs disabled:opacity-40 dark:border-zinc-700"
              >
                Previous
              </button>
              <button
                onClick={() => setOffset(o => o + PAGE_SIZE)}
                disabled={offset + PAGE_SIZE >= total}
                className="rounded-md border border-zinc-300 px-3 py-1 text-xs disabled:opacity-40 dark:border-zinc-700"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
