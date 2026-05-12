"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface ReturnRecord {
  id: string;
  order_number: string;
  status: string;
  resolution_type: string;
  source: string;
  order_total_cents: number;
  label_cost_cents: number;
  net_refund_cents: number;
  tracking_number: string | null;
  carrier: string | null;
  return_line_items: { title?: string; quantity?: number }[];
  created_at: string;
  customers: { id: string; email: string; first_name: string | null; last_name: string | null } | null;
}

const PAGE_SIZE = 25;

const STATUS_OPTIONS = [
  { value: "all", label: "All Statuses" },
  { value: "pending", label: "Pending" },
  { value: "open", label: "Open" },
  { value: "label_created", label: "Label Created" },
  { value: "in_transit", label: "In Transit" },
  { value: "delivered", label: "Delivered" },
  { value: "processing", label: "Processing" },
  { value: "restocked", label: "Restocked" },
  { value: "refunded", label: "Refunded" },
  { value: "closed", label: "Closed" },
  { value: "cancelled", label: "Cancelled" },
];

const STATUS_BADGE: Record<string, { label: string; classes: string }> = {
  pending: { label: "Pending", classes: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
  open: { label: "Open", classes: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  label_created: { label: "Label Sent", classes: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400" },
  in_transit: { label: "In Transit", classes: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
  delivered: { label: "Delivered", classes: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400" },
  processing: { label: "Processing", classes: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400" },
  restocked: { label: "Restocked", classes: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" },
  refunded: { label: "Refunded", classes: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
  closed: { label: "Closed", classes: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" },
  cancelled: { label: "Cancelled", classes: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
};

const RESOLUTION_LABELS: Record<string, string> = {
  store_credit_return: "Store Credit (return)",
  refund_return: "Refund (return)",
  store_credit_no_return: "Store Credit (no return)",
  refund_no_return: "Refund (no return)",
};

const SOURCE_BADGE: Record<string, string> = {
  playbook: "bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400",
  agent: "bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400",
  portal: "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400",
  shopify: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function ReturnsPage() {
  const workspace = useWorkspace();
  const router = useRouter();

  const [returns, setReturns] = useState<ReturnRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [status, setStatus] = useState("all");
  const [resolution, setResolution] = useState("all");
  const [source, setSource] = useState("all");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [sort, setSort] = useState("created_at");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);

  const fetchReturns = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ sort, order, limit: String(PAGE_SIZE), offset: String(offset) });
    if (status !== "all") params.set("status", status);
    if (resolution !== "all") params.set("resolution", resolution);
    if (source !== "all") params.set("source", source);
    if (appliedSearch) params.set("search", appliedSearch);

    const res = await fetch(`/api/workspaces/${workspace.id}/returns?${params}`);
    if (res.ok) {
      const data = await res.json();
      setReturns(data.returns || []);
      setTotal(data.total || 0);
    }
    setLoading(false);
  }, [workspace.id, status, resolution, source, appliedSearch, sort, order, offset]);

  useEffect(() => { fetchReturns(); }, [fetchReturns]);

  const handleSort = (col: string) => {
    if (sort === col) setOrder(o => o === "asc" ? "desc" : "asc");
    else { setSort(col); setOrder("desc"); }
    setOffset(0);
  };

  const SortIcon = ({ col }: { col: string }) => (
    sort === col ? <span className="ml-1 text-[10px]">{order === "asc" ? "\u25B2" : "\u25BC"}</span> : null
  );

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Returns</h1>
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          {total} total
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select value={status} onChange={e => { setStatus(e.target.value); setOffset(0); }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <select value={resolution} onChange={e => { setResolution(e.target.value); setOffset(0); }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          <option value="all">All Resolutions</option>
          <option value="store_credit_return">Store Credit (return)</option>
          <option value="refund_return">Refund (return)</option>
          <option value="store_credit_no_return">Store Credit (no return)</option>
          <option value="refund_no_return">Refund (no return)</option>
        </select>

        <select value={source} onChange={e => { setSource(e.target.value); setOffset(0); }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          <option value="all">All Sources</option>
          <option value="playbook">Playbook</option>
          <option value="agent">Agent</option>
          <option value="portal">Portal</option>
          <option value="shopify">Shopify</option>
        </select>

        <form onSubmit={e => { e.preventDefault(); setAppliedSearch(search); setOffset(0); }} className="flex gap-1">
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search order, customer, tracking..."
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
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("order_number")}>Order #<SortIcon col="order_number" /></th>
                <th className="px-4 py-2.5">Customer</th>
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("status")}>Status<SortIcon col="status" /></th>
                <th className="px-4 py-2.5">Resolution</th>
                <th className="cursor-pointer px-4 py-2.5 text-right" onClick={() => handleSort("net_refund_cents")}>Amount<SortIcon col="net_refund_cents" /></th>
                <th className="px-4 py-2.5">Tracking</th>
                <th className="px-4 py-2.5">Source</th>
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("created_at")}>Created<SortIcon col="created_at" /></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-zinc-400">Loading...</td></tr>
              ) : returns.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-zinc-400">
                  No returns yet. Returns are created automatically by playbooks or manually by agents.
                </td></tr>
              ) : returns.map(ret => {
                const customer = ret.customers;
                const name = customer ? `${customer.first_name || ""} ${customer.last_name || ""}`.trim() || customer.email : "--";
                const badge = STATUS_BADGE[ret.status] || STATUS_BADGE.pending;

                return (
                  <tr key={ret.id}
                    onClick={() => router.push(`/dashboard/returns/${ret.id}`)}
                    className="cursor-pointer border-b border-zinc-50 transition-colors hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/30">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-zinc-900 dark:text-zinc-100">{ret.order_number}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-zinc-900 dark:text-zinc-100">{name}</div>
                      {customer?.email && <div className="text-xs text-zinc-400">{customer.email}</div>}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${badge.classes}`}>
                        {badge.label}
                      </span>
                      {ret.status === "pending" && (
                        <span className="ml-1.5 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                          Needs Review
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-500">
                      {RESOLUTION_LABELS[ret.resolution_type] || ret.resolution_type}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-zinc-600 dark:text-zinc-400"
                      title={ret.label_cost_cents > 0 ? `${formatCents(ret.order_total_cents)} - ${formatCents(ret.label_cost_cents)} label` : undefined}>
                      {formatCents(ret.net_refund_cents)}
                    </td>
                    <td className="px-4 py-2.5">
                      {ret.tracking_number ? (
                        <span className="font-mono text-xs text-zinc-500" title={ret.tracking_number}>
                          {ret.tracking_number.length > 12 ? `${ret.tracking_number.slice(0, 12)}...` : ret.tracking_number}
                        </span>
                      ) : (
                        <span className="text-zinc-300 dark:text-zinc-600">--</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${SOURCE_BADGE[ret.source] || SOURCE_BADGE.shopify}`}>
                        {ret.source}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-zinc-400" title={new Date(ret.created_at).toLocaleString()}>
                      {timeAgo(ret.created_at)}
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
