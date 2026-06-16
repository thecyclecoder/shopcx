"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import Link from "next/link";

interface Product {
  id: string;
  title: string;
  handle: string;
  status: "active" | "draft" | "archived";
  image_url: string | null;
  intelligence_status: string | null;
  updated_at: string;
}

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "draft", label: "Draft" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All statuses" },
];

const INTEL_OPTIONS = [
  { value: "all", label: "All intelligence" },
  { value: "started", label: "Started" },
  { value: "not_started", label: "Not started" },
  { value: "published", label: "Published" },
];

const INTEL_LABEL: Record<string, string> = {
  none: "Not started",
  ingredients_added: "Ingredients added",
  researching: "Researching",
  research_complete: "Research complete",
  analyzing_reviews: "Analyzing reviews",
  reviews_complete: "Reviews complete",
  benefits_selected: "Benefits selected",
  generating_content: "Generating content",
  content_generated: "Content generated",
  published: "Published",
};

export default function ProductsPage() {
  const workspace = useWorkspace();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [intelFilter, setIntelFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/products?status=${statusFilter}`);
    if (res.ok) {
      const data = (await res.json()) as Product[];
      setProducts(data);
    }
    setLoading(false);
  }, [workspace.id, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    let out = products;
    if (intelFilter === "started") {
      out = out.filter(p => p.intelligence_status && p.intelligence_status !== "none");
    } else if (intelFilter === "not_started") {
      out = out.filter(p => !p.intelligence_status || p.intelligence_status === "none");
    } else if (intelFilter === "published") {
      out = out.filter(p => p.intelligence_status === "published");
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter(p => p.title.toLowerCase().includes(q) || (p.handle || "").toLowerCase().includes(q));
    }
    return out;
  }, [products, intelFilter, search]);

  return (
    <div className="mx-auto w-full max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Product Intelligence</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Deep product knowledge — ingredients, research, review analysis, generated PDP content. One row per product; click in to build or extend.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by title or handle..."
          className="flex-1 min-w-[240px] rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        >
          {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select
          value={intelFilter}
          onChange={(e) => setIntelFilter(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        >
          {INTEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/50 p-12 text-center dark:border-zinc-700 dark:bg-zinc-900/50">
          <p className="text-sm text-zinc-500">No products match your filters.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(p => {
            const status = p.intelligence_status || "none";
            return (
              <Link
                key={p.id}
                href={`/dashboard/products/${p.id}/intelligence`}
                className="flex items-center gap-4 rounded-lg border border-zinc-200 bg-white p-4 transition-colors hover:border-indigo-200 hover:bg-indigo-50/50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/30"
              >
                {p.image_url ? (
                  <img src={p.image_url} alt="" className="h-12 w-12 rounded-md object-cover" />
                ) : (
                  <div className="flex h-12 w-12 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
                    <svg className="h-6 w-6 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                    </svg>
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{p.title}</h3>
                  <p className="text-xs text-zinc-500">{p.handle}</p>
                </div>
                <div className="flex items-center gap-3">
                  <StatusPill status={p.status} />
                  <IntelligencePill status={status} />
                  <span className="text-xs text-zinc-400">{new Date(p.updated_at).toLocaleDateString()}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: Product["status"] }) {
  const colors: Record<Product["status"], string> = {
    active: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
    draft: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
    archived: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${colors[status]}`}>
      {status}
    </span>
  );
}

function IntelligencePill({ status }: { status: string }) {
  if (status === "none") {
    return <span className="text-[10px] text-zinc-400">Not started</span>;
  }
  const label = INTEL_LABEL[status] || status.replace(/_/g, " ");
  const color =
    status === "published"
      ? "bg-emerald-500 text-white"
      : status === "content_generated" || status === "benefits_selected"
        ? "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300"
        : "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${color}`}>
      {label}
    </span>
  );
}
