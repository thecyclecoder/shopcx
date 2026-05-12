"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import { formatItemName } from "@/components/shared/format-utils";

interface Product {
  id: string;
  shopify_product_id: string;
  title: string;
}

interface Subscription {
  id: string;
  shopify_contract_id: string;
  status: string;
  items: { title?: string; variant_title?: string; quantity?: number; price_cents?: number }[] | null;
  billing_interval: string | null;
  billing_interval_count: number | null;
  next_billing_date: string | null;
  last_payment_status: string | null;
  created_at: string;
  recovery_status: string | null;
  mrr_cents: number;
  customers: { id: string; email: string; first_name: string | null; last_name: string | null };
}

const PAGE_SIZE = 25;

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  paused: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  cancelled: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  expired: "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500",
};

const RECOVERY_BADGE: Record<string, { label: string; classes: string }> = {
  in_recovery: { label: "In Recovery", classes: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
  failed: { label: "Payment Failed", classes: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
  recovered: { label: "Recovered", classes: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" },
};

const PAYMENT_BADGE: Record<string, string> = {
  succeeded: "text-emerald-600",
  failed: "text-red-600",
  skipped: "text-amber-600",
};

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function formatDate(d: string | null): string {
  if (!d) return "--";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function SubscriptionsPage() {
  const workspace = useWorkspace();
  const router = useRouter();

  const [subs, setSubs] = useState<Subscription[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // Products for filter
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [productDropdownOpen, setProductDropdownOpen] = useState(false);
  const productDropdownRef = useRef<HTMLDivElement>(null);

  // Filters
  const [status, setStatus] = useState("active");
  const [recovery, setRecovery] = useState("all");
  const [payment, setPayment] = useState("all");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [sort, setSort] = useState("next_billing_date");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [offset, setOffset] = useState(0);

  // Load products list once
  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/products`)
      .then(r => r.ok ? r.json() : [])
      .then(setProducts);
  }, [workspace.id]);

  // Close product dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (productDropdownRef.current && !productDropdownRef.current.contains(e.target as Node)) {
        setProductDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const toggleProduct = (shopifyProductId: string) => {
    setSelectedProducts(prev =>
      prev.includes(shopifyProductId)
        ? prev.filter(id => id !== shopifyProductId)
        : [...prev, shopifyProductId]
    );
    setOffset(0);
  };

  const fetchSubs = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ sort, order, limit: String(PAGE_SIZE), offset: String(offset) });
    if (status !== "all") params.set("status", status);
    if (recovery !== "all") params.set("recovery", recovery);
    if (payment !== "all") params.set("payment", payment);
    if (appliedSearch) params.set("search", appliedSearch);
    if (selectedProducts.length > 0) params.set("products", selectedProducts.join(","));

    const res = await fetch(`/api/workspaces/${workspace.id}/subscriptions?${params}`);
    if (res.ok) {
      const data = await res.json();
      setSubs(data.subscriptions || []);
      setTotal(data.total || 0);
    }
    setLoading(false);
  }, [workspace.id, status, recovery, payment, appliedSearch, selectedProducts, sort, order, offset]);

  useEffect(() => { fetchSubs(); }, [fetchSubs]);

  const handleSort = (col: string) => {
    if (sort === col) setOrder(o => o === "asc" ? "desc" : "asc");
    else { setSort(col); setOrder("asc"); }
    setOffset(0);
  };

  const SortIcon = ({ col }: { col: string }) => (
    sort === col ? <span className="ml-1 text-[10px]">{order === "asc" ? "\u25B2" : "\u25BC"}</span> : null
  );

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Subscriptions</h1>
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          {total} total
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select value={status} onChange={e => { setStatus(e.target.value); setOffset(0); }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="cancelled">Cancelled</option>
          <option value="expired">Expired</option>
        </select>

        <select value={recovery} onChange={e => { setRecovery(e.target.value); setOffset(0); }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          <option value="all">All Recovery</option>
          <option value="in_recovery">In Recovery</option>
          <option value="recovered">Recovered</option>
          <option value="failed">Failed</option>
        </select>

        <select value={payment} onChange={e => { setPayment(e.target.value); setOffset(0); }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          <option value="all">All Payments</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="skipped">Skipped</option>
        </select>

        <div ref={productDropdownRef} className="relative">
          <button
            type="button"
            onClick={() => setProductDropdownOpen(o => !o)}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              selectedProducts.length > 0
                ? "border-blue-400 bg-blue-50 text-blue-700 dark:border-blue-600 dark:bg-blue-900/30 dark:text-blue-400"
                : "border-zinc-300 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            }`}
          >
            Products{selectedProducts.length > 0 ? ` (${selectedProducts.length})` : ""}
            <span className="ml-1 text-[10px]">{productDropdownOpen ? "\u25B2" : "\u25BC"}</span>
          </button>
          {productDropdownOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 max-h-64 w-full sm:w-64 overflow-y-auto rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
              {selectedProducts.length > 0 && (
                <button
                  type="button"
                  onClick={() => { setSelectedProducts([]); setOffset(0); }}
                  className="w-full border-b border-zinc-100 px-3 py-1.5 text-left text-xs text-red-500 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-700/50"
                >
                  Clear all
                </button>
              )}
              {products.map(p => (
                <label
                  key={p.shopify_product_id}
                  className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-700/50"
                >
                  <input
                    type="checkbox"
                    checked={selectedProducts.includes(p.shopify_product_id)}
                    onChange={() => toggleProduct(p.shopify_product_id)}
                    className="rounded border-zinc-300 text-blue-600"
                  />
                  <span className="truncate text-zinc-700 dark:text-zinc-300">{p.title}</span>
                </label>
              ))}
              {products.length === 0 && (
                <p className="px-3 py-2 text-xs text-zinc-400">No products found</p>
              )}
            </div>
          )}
        </div>

        <form onSubmit={e => { e.preventDefault(); setAppliedSearch(search); setOffset(0); }} className="flex w-full gap-1 sm:w-auto">
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search customer..."
            className="w-full sm:w-48 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" />
          <button type="submit" className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm dark:bg-zinc-700">Go</button>
        </form>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase text-zinc-400 dark:border-zinc-800">
                <th className="px-4 py-2.5">Customer</th>
                <th className="px-4 py-2.5">Products</th>
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("status")}>Status<SortIcon col="status" /></th>
                <th className="px-4 py-2.5">Recovery</th>
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("next_billing_date")}>Next Billing<SortIcon col="next_billing_date" /></th>
                <th className="px-4 py-2.5">Payment</th>
                <th className="px-4 py-2.5 text-right">MRR</th>
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("created_at")}>Created<SortIcon col="created_at" /></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-zinc-400">Loading...</td></tr>
              ) : subs.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-zinc-400">No subscriptions found</td></tr>
              ) : subs.map(sub => {
                const items = sub.items || [];
                const customer = sub.customers;
                const name = `${customer?.first_name || ""} ${customer?.last_name || ""}`.trim() || customer?.email || "";

                return (
                  <tr key={sub.id}
                    onClick={() => router.push(`/dashboard/subscriptions/${sub.id}`)}
                    className="cursor-pointer border-b border-zinc-50 transition-colors hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/30">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-zinc-900 dark:text-zinc-100">{name}</div>
                      <div className="text-xs text-zinc-400">{customer?.email}</div>
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                      {items.slice(0, 2).map(i => formatItemName(i)).join(", ")}
                      {items.length > 2 && <span className="text-zinc-400"> +{items.length - 2}</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[sub.status] || STATUS_BADGE.active}`}>
                        {sub.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      {sub.recovery_status && RECOVERY_BADGE[sub.recovery_status] && (
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${RECOVERY_BADGE[sub.recovery_status].classes}`}>
                          {RECOVERY_BADGE[sub.recovery_status].label}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-zinc-500">{formatDate(sub.next_billing_date)}</td>
                    <td className="px-4 py-2.5">
                      {sub.last_payment_status && (
                        <span className={`text-xs font-medium ${PAYMENT_BADGE[sub.last_payment_status] || "text-zinc-400"}`}>
                          {sub.last_payment_status}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                      {formatCents(sub.mrr_cents)}/mo
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-zinc-400">{formatDate(sub.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex flex-col items-center gap-2 border-t border-zinc-100 px-4 py-3 sm:flex-row sm:justify-between dark:border-zinc-800">
            <p className="text-xs text-zinc-500">{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}</p>
            <div className="flex gap-2">
              <button onClick={() => setOffset(o => Math.max(0, o - PAGE_SIZE))} disabled={offset === 0}
                className="rounded-md border border-zinc-300 px-3 py-1 text-xs disabled:opacity-40 dark:border-zinc-700">Previous</button>
              <button onClick={() => setOffset(o => o + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total}
                className="rounded-md border border-zinc-300 px-3 py-1 text-xs disabled:opacity-40 dark:border-zinc-700">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
