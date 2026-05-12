"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface Replacement {
  id: string;
  original_order_number: string | null;
  shopify_replacement_order_name: string | null;
  reason: string;
  reason_detail: string | null;
  status: string;
  customer_error: boolean;
  items: { title: string; quantity: number }[] | null;
  created_at: string;
  customers: { id: string; first_name: string; last_name: string; email: string } | null;
}

const PAGE_SIZE = 25;

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  address_confirmed: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  created: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
  shipped: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  completed: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  denied: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

const REASON_LABELS: Record<string, string> = {
  delivery_error: "Delivery Error",
  missing_items: "Missing Items",
  damaged_items: "Damaged Items",
  wrong_address: "Wrong Address",
  carrier_lost: "Carrier Lost",
  not_received: "Not Received",
  refused: "Refused",
};

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function ReplacementsPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const [replacements, setReplacements] = useState<Replacement[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [reasonFilter, setReasonFilter] = useState("all");
  const [offset, setOffset] = useState(0);

  const fetchReplacements = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), sort: "created_at", order: "desc" });
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (reasonFilter !== "all") params.set("reason", reasonFilter);

    const res = await fetch(`/api/workspaces/${workspace.id}/replacements?${params}`);
    if (res.ok) {
      const data = await res.json();
      setReplacements(data.replacements || []);
      setTotal(data.total || 0);
    }
    setLoading(false);
  }, [workspace.id, statusFilter, reasonFilter, offset]);

  useEffect(() => { fetchReplacements(); }, [fetchReplacements]);

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Replacements</h1>
        <p className="mt-1 text-sm text-zinc-500">{total} replacement orders</p>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setOffset(0); }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        >
          <option value="all">All Status</option>
          <option value="pending">Pending</option>
          <option value="address_confirmed">Address Confirmed</option>
          <option value="created">Created</option>
          <option value="shipped">Shipped</option>
          <option value="completed">Completed</option>
          <option value="denied">Denied</option>
        </select>

        <select
          value={reasonFilter}
          onChange={e => { setReasonFilter(e.target.value); setOffset(0); }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        >
          <option value="all">All Reasons</option>
          <option value="delivery_error">Delivery Error</option>
          <option value="missing_items">Missing Items</option>
          <option value="damaged_items">Damaged Items</option>
          <option value="wrong_address">Wrong Address</option>
          <option value="carrier_lost">Carrier Lost</option>
          <option value="not_received">Not Received</option>
        </select>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase text-zinc-400 dark:border-zinc-800">
                <th className="px-4 py-2.5">Customer</th>
                <th className="px-4 py-2.5">Original Order</th>
                <th className="px-4 py-2.5">Reason</th>
                <th className="px-4 py-2.5">Items</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Replacement Order</th>
                <th className="px-4 py-2.5">Created</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-zinc-400">Loading...</td></tr>
              ) : replacements.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-zinc-400">No replacements found</td></tr>
              ) : (
                replacements.map(r => (
                  <tr
                    key={r.id}
                    onClick={() => router.push(`/dashboard/replacements/${r.id}`)}
                    className="cursor-pointer border-b border-zinc-50 transition-colors hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/30"
                  >
                    <td className="px-4 py-2.5">
                      {r.customers ? (
                        <div>
                          <div className="font-medium text-zinc-900 dark:text-zinc-100">
                            {r.customers.first_name} {r.customers.last_name}
                          </div>
                          <div className="text-xs text-zinc-400">{r.customers.email}</div>
                        </div>
                      ) : <span className="text-zinc-400">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                      {r.original_order_number || "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="text-xs text-zinc-700 dark:text-zinc-300">
                        {REASON_LABELS[r.reason] || r.reason}
                      </div>
                      {r.reason_detail && (
                        <div className="mt-0.5 text-xs text-zinc-400">{r.reason_detail}</div>
                      )}
                      {r.customer_error && (
                        <span className="mt-0.5 inline-block rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:bg-amber-900/20 dark:text-amber-400">
                          Customer Error
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-zinc-500">
                      {r.items ? r.items.map(i => `${i.quantity}x ${i.title}`).join(", ") : "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[r.status] || STATUS_COLORS.pending}`}>
                        {r.status.replace("_", " ")}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                      {r.shopify_replacement_order_name || "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-zinc-400">{formatDate(r.created_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
            <p className="text-xs text-zinc-500">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
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
