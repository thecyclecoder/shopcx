"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface Customer {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  retention_score: number;
  ltv_cents: number;
  total_orders: number;
  last_order_at: string | null;
}

type SortField = "retention_score" | "ltv_cents" | "total_orders" | "last_order_at";

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "--";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function RetentionBadge({ score }: { score: number }) {
  let classes: string;
  if (score > 70) {
    classes = "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400";
  } else if (score >= 40) {
    classes = "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
  } else {
    classes = "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
  }
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}>
      {score}
    </span>
  );
}

const PAGE_SIZE = 25;

interface SyncState {
  phase: "idle" | "counting" | "customers" | "orders" | "finalizing" | "done" | "error";
  totalCustomers: number;
  totalOrders: number;
  syncedCustomers: number;
  syncedOrders: number;
  error: string | null;
}

export default function CustomersPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const abortRef = useRef(false);

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortField>("retention_score");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);

  const [sync, setSync] = useState<SyncState>({
    phase: "idle",
    totalCustomers: 0,
    totalOrders: 0,
    syncedCustomers: 0,
    syncedOrders: 0,
    error: null,
  });

  const fetchCustomers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        sort,
        order,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (search) params.set("search", search);
      const res = await fetch(`/api/customers?${params}`);
      const data = await res.json();
      if (res.ok) {
        setCustomers(data.customers);
        setTotal(data.total);
      }
    } finally {
      setLoading(false);
    }
  }, [search, sort, order, offset]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  const handleSort = (field: SortField) => {
    if (sort === field) {
      setOrder(order === "asc" ? "desc" : "asc");
    } else {
      setSort(field);
      setOrder("desc");
    }
    setOffset(0);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setOffset(0);
    fetchCustomers();
  };

  // ── Sync with progress ──

  const handleSync = async () => {
    abortRef.current = false;

    setSync({
      phase: "counting",
      totalCustomers: 0,
      totalOrders: 0,
      syncedCustomers: 0,
      syncedOrders: 0,
      error: null,
    });

    try {
      // Step 1: Get counts
      const countRes = await fetch(`/api/workspaces/${workspace.id}/sync`);
      if (!countRes.ok) throw new Error("Failed to get counts");
      const counts = await countRes.json();

      setSync((s) => ({
        ...s,
        phase: "customers",
        totalCustomers: counts.customers,
        totalOrders: counts.orders,
      }));

      // Step 2: Sync customers page by page
      let customerCursor: string | null = null;
      let customersSynced = 0;
      let hasMoreCustomers = true;

      while (hasMoreCustomers) {
        if (abortRef.current) throw new Error("Sync cancelled");

        const custRes: Response = await fetch(`/api/workspaces/${workspace.id}/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "customers", cursor: customerCursor }),
        });

        if (!custRes.ok) {
          const errData = await custRes.json();
          throw new Error(errData.error || "Customer sync failed");
        }

        const page = await custRes.json();
        customersSynced += page.synced;

        setSync((s) => ({ ...s, syncedCustomers: customersSynced }));

        hasMoreCustomers = page.hasMore;
        customerCursor = page.nextCursor;
      }

      // Step 3: Sync orders page by page
      setSync((s) => ({ ...s, phase: "orders" }));
      let orderCursor: string | null = null;
      let ordersSynced = 0;
      let hasMoreOrders = true;

      while (hasMoreOrders) {
        if (abortRef.current) throw new Error("Sync cancelled");

        const ordRes: Response = await fetch(`/api/workspaces/${workspace.id}/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "orders", cursor: orderCursor }),
        });

        if (!ordRes.ok) {
          const errData = await ordRes.json();
          throw new Error(errData.error || "Order sync failed");
        }

        const page = await ordRes.json();
        ordersSynced += page.synced;

        setSync((s) => ({ ...s, syncedOrders: ordersSynced }));

        hasMoreOrders = page.hasMore;
        orderCursor = page.nextCursor;
      }

      // Step 4: Finalize (order dates + retention scores)
      setSync((s) => ({ ...s, phase: "finalizing" }));

      const finalRes = await fetch(`/api/workspaces/${workspace.id}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "finalize", cursor: null }),
      });

      if (!finalRes.ok) throw new Error("Finalize failed");

      setSync((s) => ({ ...s, phase: "done" }));
      fetchCustomers();
    } catch (err) {
      setSync((s) => ({
        ...s,
        phase: "error",
        error: err instanceof Error ? err.message : "Sync failed",
      }));
    }
  };

  const handleCancelSync = () => {
    abortRef.current = true;
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const isSyncing = !["idle", "done", "error"].includes(sync.phase);

  // Progress calculation
  let progressPercent = 0;
  let progressLabel = "";

  if (sync.phase === "counting") {
    progressLabel = "Getting store info...";
  } else if (sync.phase === "customers") {
    progressPercent = sync.totalCustomers > 0
      ? Math.round((sync.syncedCustomers / sync.totalCustomers) * 50)
      : 0;
    progressLabel = `Syncing customers: ${sync.syncedCustomers.toLocaleString()} / ${sync.totalCustomers.toLocaleString()}`;
  } else if (sync.phase === "orders") {
    progressPercent = sync.totalOrders > 0
      ? 50 + Math.round((sync.syncedOrders / sync.totalOrders) * 45)
      : 50;
    progressLabel = `Syncing orders: ${sync.syncedOrders.toLocaleString()} / ${sync.totalOrders.toLocaleString()}`;
  } else if (sync.phase === "finalizing") {
    progressPercent = 95;
    progressLabel = "Calculating retention scores...";
  } else if (sync.phase === "done") {
    progressPercent = 100;
    progressLabel = `Done! ${sync.syncedCustomers.toLocaleString()} customers, ${sync.syncedOrders.toLocaleString()} orders synced.`;
  } else if (sync.phase === "error") {
    progressLabel = sync.error || "Sync failed";
  }

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sort !== field) return null;
    return (
      <svg className="ml-1 inline h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d={order === "asc" ? "M5 15l7-7 7 7" : "M19 9l-7 7-7-7"} />
      </svg>
    );
  };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Customers</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {total} customer{total !== 1 ? "s" : ""} in this workspace.
          </p>
        </div>
        {!isSyncing ? (
          <button
            onClick={handleSync}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
          >
            Sync Customers
          </button>
        ) : (
          <button
            onClick={handleCancelSync}
            className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-800 dark:text-red-400"
          >
            Cancel
          </button>
        )}
      </div>

      {/* ── Progress Bar ── */}
      {sync.phase !== "idle" && (
        <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between text-sm">
            <span className={sync.phase === "error" ? "text-red-500" : "text-zinc-700 dark:text-zinc-300"}>
              {progressLabel}
            </span>
            {sync.phase !== "error" && sync.phase !== "counting" && (
              <span className="text-xs text-zinc-400">{progressPercent}%</span>
            )}
          </div>
          {sync.phase !== "error" && (
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  sync.phase === "done"
                    ? "bg-emerald-500"
                    : sync.phase === "counting"
                      ? "animate-pulse bg-indigo-300"
                      : "bg-indigo-500"
                }`}
                style={{ width: sync.phase === "counting" ? "100%" : `${progressPercent}%` }}
              />
            </div>
          )}
          {sync.phase === "done" && (
            <button
              onClick={() => setSync((s) => ({ ...s, phase: "idle" }))}
              className="mt-2 text-xs text-zinc-400 hover:text-zinc-600"
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* ── Search ── */}
      <form onSubmit={handleSearch} className="mt-6">
        <div className="relative">
          <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            type="text"
            placeholder="Search by email or name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="block w-full rounded-md border border-zinc-300 bg-white py-2 pl-10 pr-3 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
        </div>
      </form>

      {/* ── Table ── */}
      <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-800">
          <thead>
            <tr className="text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="cursor-pointer px-4 py-3" onClick={() => handleSort("retention_score")}>
                Retention <SortIcon field="retention_score" />
              </th>
              <th className="cursor-pointer px-4 py-3" onClick={() => handleSort("ltv_cents")}>
                LTV <SortIcon field="ltv_cents" />
              </th>
              <th className="cursor-pointer px-4 py-3" onClick={() => handleSort("total_orders")}>
                Orders <SortIcon field="total_orders" />
              </th>
              <th className="cursor-pointer px-4 py-3" onClick={() => handleSort("last_order_at")}>
                Last Order <SortIcon field="last_order_at" />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-zinc-400">Loading...</td>
              </tr>
            ) : customers.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-zinc-400">
                  No customers found. Try syncing from Shopify.
                </td>
              </tr>
            ) : (
              customers.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => router.push(`/dashboard/customers/${c.id}`)}
                  className="cursor-pointer transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                >
                  <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {[c.first_name, c.last_name].filter(Boolean).join(" ") || "--"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-zinc-500">{c.email}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    <RetentionBadge score={c.retention_score} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-zinc-700 dark:text-zinc-300">
                    {formatCents(c.ltv_cents)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-zinc-700 dark:text-zinc-300">
                    {c.total_orders}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-zinc-500">
                    {formatDate(c.last_order_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-zinc-500">
            Showing {offset + 1}--{Math.min(offset + PAGE_SIZE, total)} of {total}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Previous
            </button>
            <span className="flex items-center px-2 text-sm text-zinc-500">
              Page {currentPage} of {totalPages}
            </span>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
