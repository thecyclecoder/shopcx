"use client";

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import Link from "next/link";

interface ProductIntelligence {
  id: string;
  product_id: string;
  title: string;
  source: string;
  source_urls: string[];
  created_at: string;
  updated_at: string;
  products: { id: string; title: string; image_url: string | null } | null;
}

export default function ProductsPage() {
  const workspace = useWorkspace();
  const [items, setItems] = useState<ProductIntelligence[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const fetchData = useCallback(async () => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    const res = await fetch(`/api/workspaces/${workspace.id}/product-intelligence?${params}`);
    if (res.ok) {
      const data = await res.json();
      setItems(data.items || []);
    }
    setLoading(false);
  }, [workspace.id, search]);

  useEffect(() => { fetchData(); }, [fetchData]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Product Intelligence</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Deep product knowledge from ShopGrowth or manual input. Used to audit KB articles and macros.
          </p>
        </div>
        <Link
          href="/dashboard/products/new"
          className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600"
        >
          Add Product
        </Link>
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search products..."
          className="w-full max-w-sm rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        />
      </div>

      {loading ? (
        <p className="text-sm text-zinc-400">Loading...</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/50 p-12 text-center dark:border-zinc-700 dark:bg-zinc-900/50">
          <p className="text-sm text-zinc-500">No product intelligence yet.</p>
          <p className="mt-1 text-xs text-zinc-400">Add a product and paste the LLM export from ShopGrowth to get started.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(item => (
            <Link
              key={item.id}
              href={`/dashboard/products/${item.id}`}
              className="flex items-center gap-4 rounded-lg border border-zinc-200 bg-white p-4 transition-colors hover:border-indigo-200 hover:bg-indigo-50/50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/30"
            >
              {item.products?.image_url ? (
                <img src={item.products.image_url} alt="" className="h-12 w-12 rounded-md object-cover" />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
                  <svg className="h-6 w-6 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                  </svg>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{item.title}</h3>
                <p className="text-xs text-zinc-500">{item.products?.title || "No product linked"}</p>
              </div>
              <div className="flex items-center gap-3 text-xs text-zinc-400">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  item.source === "shopgrowth" ? "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300"
                  : item.source === "url_scrape" ? "bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300"
                  : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"
                }`}>
                  {item.source === "shopgrowth" ? "ShopGrowth" : item.source === "url_scrape" ? "URL" : "Manual"}
                </span>
                {item.source_urls.length > 0 && <span>{item.source_urls.length} URL{item.source_urls.length !== 1 ? "s" : ""}</span>}
                <span>{new Date(item.updated_at).toLocaleDateString()}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
