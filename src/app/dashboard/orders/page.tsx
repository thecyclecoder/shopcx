"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface Order {
  id: string;
  order_number: string;
  email: string;
  total_cents: number;
  currency: string;
  financial_status: string;
  fulfillment_status: string;
  line_items: { sku?: string; title?: string; quantity?: number }[] | null;
  created_at: string;
  tags: string | null;
  shopify_order_id: string;
  amplifier_order_id: string | null;
  amplifier_received_at: string | null;
  amplifier_shipped_at: string | null;
  amplifier_tracking_number: string | null;
  amplifier_carrier: string | null;
  amplifier_status: string | null;
  customers: { id: string; email: string; first_name: string | null; last_name: string | null } | null;
}

interface Counts {
  sync_error: number;
  suspicious: number;
  late_tracking: number;
  awaiting_tracking: number;
  in_transit: number;
  fulfilled: number;
}

const PAGE_SIZE = 25;

type FilterKey = "all" | "sync_error" | "suspicious" | "late_tracking" | "awaiting_tracking" | "in_transit" | "fulfilled";

const FILTER_CARDS: { key: FilterKey; label: string; color: string; activeColor: string; countKey?: keyof Counts }[] = [
  { key: "sync_error", label: "Sync Errors", color: "border-red-200 dark:border-red-900", activeColor: "border-red-500 bg-red-50 dark:border-red-500 dark:bg-red-950", countKey: "sync_error" },
  { key: "suspicious", label: "Suspicious", color: "border-amber-200 dark:border-amber-900", activeColor: "border-amber-500 bg-amber-50 dark:border-amber-500 dark:bg-amber-950", countKey: "suspicious" },
  { key: "late_tracking", label: "Late Tracking", color: "border-red-200 dark:border-red-900", activeColor: "border-red-500 bg-red-50 dark:border-red-500 dark:bg-red-950", countKey: "late_tracking" },
  { key: "awaiting_tracking", label: "Awaiting Tracking", color: "border-zinc-200 dark:border-zinc-700", activeColor: "border-zinc-500 bg-zinc-50 dark:border-zinc-500 dark:bg-zinc-800", countKey: "awaiting_tracking" },
  { key: "in_transit", label: "In Transit", color: "border-blue-200 dark:border-blue-900", activeColor: "border-blue-500 bg-blue-50 dark:border-blue-500 dark:bg-blue-950", countKey: "in_transit" },
  { key: "fulfilled", label: "Fulfilled", color: "border-emerald-200 dark:border-emerald-900", activeColor: "border-emerald-500 bg-emerald-50 dark:border-emerald-500 dark:bg-emerald-950", countKey: "fulfilled" },
];

const COUNT_COLORS: Record<string, string> = {
  sync_error: "text-red-600 dark:text-red-400",
  suspicious: "text-amber-600 dark:text-amber-400",
  late_tracking: "text-red-600 dark:text-red-400",
  awaiting_tracking: "text-zinc-600 dark:text-zinc-400",
  in_transit: "text-blue-600 dark:text-blue-400",
  fulfilled: "text-emerald-600 dark:text-emerald-400",
};

const STATUS_BADGE: Record<string, string> = {
  sync_error: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  suspicious: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  awaiting_tracking: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  late_tracking: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  in_transit: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  fulfilled: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
};

const EDITABLE_STATUSES = ["Awaiting Inventory", "Processing Shipment"];

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function formatDate(d: string | null): string {
  if (!d) return "--";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function getOrderStatus(order: Order): { label: string; key: string } {
  const tagStr = (order.tags as unknown as string) || "";
  if (tagStr.includes("suspicious")) return { label: "Suspicious", key: "suspicious" };
  if (order.fulfillment_status === "fulfilled") return { label: "Fulfilled", key: "fulfilled" };
  if (order.amplifier_shipped_at) return { label: "In Transit", key: "in_transit" };
  if (order.amplifier_order_id) {
    // Has amplifier ID — either awaiting or late (we show amplifier_status if available)
    return { label: order.amplifier_status || "Awaiting Tracking", key: "awaiting_tracking" };
  }
  // No amplifier ID and older than 6 hours
  const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
  if (new Date(order.created_at).getTime() < sixHoursAgo) {
    return { label: "Sync Error", key: "sync_error" };
  }
  return { label: "Pending", key: "awaiting_tracking" };
}

export default function OrdersPage() {
  const workspace = useWorkspace();
  const router = useRouter();

  const [orders, setOrders] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState<Counts>({ sync_error: 0, suspicious: 0, late_tracking: 0, awaiting_tracking: 0, in_transit: 0, fulfilled: 0 });
  const [shopifyDomain, setShopifyDomain] = useState("");

  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [sort, setSort] = useState("created_at");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);

  // Fetch counts
  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/orders?counts=true`)
      .then(r => r.json())
      .then(data => { if (data.counts) setCounts(data.counts); });
  }, [workspace.id]);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      filter,
      sort,
      order,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (appliedSearch) params.set("search", appliedSearch);

    const res = await fetch(`/api/workspaces/${workspace.id}/orders?${params}`);
    if (res.ok) {
      const data = await res.json();
      setOrders(data.orders || []);
      setTotal(data.total || 0);
      if (data.shopify_domain) setShopifyDomain(data.shopify_domain);
    }
    setLoading(false);
  }, [workspace.id, filter, appliedSearch, sort, order, offset]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  const handleSort = (col: string) => {
    if (sort === col) setOrder(o => o === "asc" ? "desc" : "asc");
    else { setSort(col); setOrder("desc"); }
    setOffset(0);
  };

  const SortIcon = ({ col }: { col: string }) => (
    sort === col ? <span className="ml-1 text-[10px]">{order === "asc" ? "\u25B2" : "\u25BC"}</span> : null
  );

  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Orders</h1>
        <button
          onClick={() => { setFilter("all"); setOffset(0); }}
          className={`text-sm ${filter === "all" ? "font-medium text-indigo-600 dark:text-indigo-400" : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}
        >
          All Orders ({totalCount})
        </button>
      </div>

      {/* Info banner */}
      <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300">
        <strong>Note:</strong> Changes made in Shopify after an order is sent to Amplifier will not sync. Address or item changes must be made directly in the Amplifier dashboard.
      </div>

      {/* Summary cards */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {FILTER_CARDS.map(card => {
          const count = card.countKey ? counts[card.countKey] : 0;
          const isActive = filter === card.key;
          return (
            <button
              key={card.key}
              onClick={() => { setFilter(card.key); setOffset(0); }}
              className={`rounded-lg border-2 px-3 py-3 text-left transition-colors ${isActive ? card.activeColor : card.color + " bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800"}`}
            >
              <div className={`text-2xl font-bold tabular-nums ${COUNT_COLORS[card.key]}`}>{count}</div>
              <div className="mt-0.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">{card.label}</div>
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div className="mb-4">
        <form onSubmit={e => { e.preventDefault(); setAppliedSearch(search); setOffset(0); }} className="flex gap-1">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by order #, customer name, or email..."
            className="w-72 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          />
          <button type="submit" className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm dark:bg-zinc-700 dark:text-zinc-300">Search</button>
          {appliedSearch && (
            <button type="button" onClick={() => { setSearch(""); setAppliedSearch(""); setOffset(0); }}
              className="rounded-md px-2 py-1.5 text-sm text-zinc-400 hover:text-zinc-600">Clear</button>
          )}
        </form>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase text-zinc-400 dark:border-zinc-800">
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("order_number")}>Order<SortIcon col="order_number" /></th>
                <th className="px-4 py-2.5">Customer</th>
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("created_at")}>Date<SortIcon col="created_at" /></th>
                <th className="px-4 py-2.5">Items</th>
                <th className="cursor-pointer px-4 py-2.5 text-right" onClick={() => handleSort("total_cents")}>Total<SortIcon col="total_cents" /></th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Tracking</th>
                <th className="px-4 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-zinc-400">Loading...</td></tr>
              ) : orders.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-zinc-400">No orders found</td></tr>
              ) : orders.map(o => {
                const customer = o.customers;
                const name = `${customer?.first_name || ""} ${customer?.last_name || ""}`.trim() || customer?.email || o.email || "";
                const items = o.line_items || [];
                const status = getOrderStatus(o);
                const isEditable = o.amplifier_status && EDITABLE_STATUSES.includes(o.amplifier_status);

                return (
                  <tr key={o.id}
                    onClick={() => router.push(`/dashboard/orders/${o.id}`)}
                    className="cursor-pointer border-b border-zinc-50 transition-colors hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/30">
                    <td className="whitespace-nowrap px-4 py-2.5 font-medium text-zinc-900 dark:text-zinc-100">
                      {o.order_number}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="text-zinc-900 dark:text-zinc-100">{name}</div>
                      <div className="text-xs text-zinc-400">{customer?.email || o.email}</div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-zinc-500">{formatDate(o.created_at)}</td>
                    <td className="max-w-[160px] truncate px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                      {items.slice(0, 2).map(i => i.title || i.sku || "Item").join(", ")}
                      {items.length > 2 && <span className="text-zinc-400"> +{items.length - 2}</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                      {formatCents(o.total_cents)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[status.key] || STATUS_BADGE.awaiting_tracking}`}>
                        {status.label}
                      </span>
                      {isEditable && (
                        <span className="ml-1 text-[10px] font-medium text-blue-500 dark:text-blue-400">Editable</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {o.amplifier_tracking_number ? (
                        <div>
                          <span className="font-mono text-xs text-zinc-600 dark:text-zinc-400">{o.amplifier_tracking_number}</span>
                          {o.amplifier_carrier && (
                            <div className="text-[10px] text-zinc-400">{o.amplifier_carrier}</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-zinc-300 dark:text-zinc-600">--</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        {o.amplifier_order_id && (
                          <a
                            href={`https://my.amplifier.com/orders/${o.amplifier_order_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="View in Amplifier"
                            className="text-zinc-400 transition-colors hover:text-blue-600 dark:hover:text-blue-400"
                            onClick={e => e.stopPropagation()}
                          >
                            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                              <polyline points="3.29 7 12 12 20.71 7" />
                              <line x1="12" y1="22" x2="12" y2="12" />
                            </svg>
                          </a>
                        )}
                        {shopifyDomain && o.shopify_order_id && (
                          <a
                            href={`https://${shopifyDomain}/admin/orders/${o.shopify_order_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="View in Shopify"
                            className="text-zinc-400 transition-colors hover:text-emerald-600 dark:hover:text-emerald-400"
                            onClick={e => e.stopPropagation()}
                          >
                            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                              <polyline points="15 3 21 3 21 9" />
                              <line x1="10" y1="14" x2="21" y2="3" />
                            </svg>
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
            <p className="text-xs text-zinc-500">{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}</p>
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
