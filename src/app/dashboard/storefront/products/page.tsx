"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import Link from "next/link";

interface Variant {
  id?: string;
  title?: string;
  sku?: string;
  price_cents?: number;
  image_url?: string | null;
}

interface Product {
  id: string;
  shopify_product_id: string;
  title: string;
  handle: string;
  product_type: string | null;
  vendor: string | null;
  status: "active" | "draft" | "archived";
  tags: string[] | null;
  image_url: string | null;
  variants: Variant[] | null;
  intelligence_status: string | null;
  updated_at: string;
}

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "draft", label: "Draft" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All statuses" },
];

function formatPrice(cents?: number): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

export default function StorefrontProductsPage() {
  const workspace = useWorkspace();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("active");
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

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!search.trim()) return products;
    const q = search.toLowerCase();
    return products.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        (p.handle || "").toLowerCase().includes(q) ||
        (p.vendor || "").toLowerCase().includes(q),
    );
  }, [products, search]);

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Products</h1>
          <p className="mt-1 text-sm text-zinc-500">
            The products that live in your store. Currently synced from Shopify — eventually the source of truth for your storefront.
          </p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by title, handle, or vendor..."
          className="flex-1 min-w-[240px] rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-400">Loading products...</p>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/50 p-12 text-center dark:border-zinc-700 dark:bg-zinc-900/50">
          <p className="text-sm text-zinc-500">No products match your filters.</p>
          <p className="mt-1 text-xs text-zinc-400">
            If you haven&apos;t synced from Shopify yet, do that from Settings &rarr; Integrations.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50">
              <tr className="text-left text-[10px] uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-2">Product</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Variants</th>
                <th className="px-4 py-2">Price range</th>
                <th className="px-4 py-2">Intelligence</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const variants = p.variants || [];
                const prices = variants
                  .map((v) => v.price_cents)
                  .filter((c): c is number => typeof c === "number");
                const priceRange =
                  prices.length === 0
                    ? "—"
                    : Math.min(...prices) === Math.max(...prices)
                      ? formatPrice(prices[0])
                      : `${formatPrice(Math.min(...prices))} – ${formatPrice(Math.max(...prices))}`;

                return (
                  <tr
                    key={p.id}
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/storefront/products/${p.id}`}
                        className="flex items-center gap-3 hover:text-indigo-600"
                      >
                        {p.image_url ? (
                          <img src={p.image_url} alt="" className="h-10 w-10 rounded object-cover" />
                        ) : (
                          <div className="h-10 w-10 rounded bg-zinc-100 dark:bg-zinc-800" />
                        )}
                        <div>
                          <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{p.title}</div>
                          <div className="text-[11px] text-zinc-500">{p.handle}</div>
                        </div>
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill status={p.status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                      {p.product_type || "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                      {variants.length}
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                      {priceRange}
                    </td>
                    <td className="px-4 py-3">
                      <IntelligencePill status={p.intelligence_status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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

function IntelligencePill({ status }: { status: string | null }) {
  if (!status || status === "none") {
    return <span className="text-[10px] text-zinc-400">Not started</span>;
  }
  const color =
    status === "published"
      ? "bg-emerald-500 text-white"
      : status === "content_generated" || status === "benefits_selected"
        ? "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300"
        : "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${color}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}
