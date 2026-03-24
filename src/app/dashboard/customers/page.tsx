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

interface SyncJob {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  phase: string | null;
  total_customers: number;
  synced_customers: number;
  total_orders: number;
  synced_orders: number;
  error: string | null;
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

export default function CustomersPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [sort, setSort] = useState<SortField>("retention_score");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);

  const [syncJob, setSyncJob] = useState<SyncJob | null>(null);

  const fetchCustomers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        sort,
        order,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (appliedSearch) params.set("search", appliedSearch);
      const res = await fetch(`/api/customers?${params}`);
      const data = await res.json();
      if (res.ok) {
        setCustomers(data.customers);
        setTotal(data.total);
      }
    } finally {
      setLoading(false);
    }
  }, [appliedSearch, sort, order, offset]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  // Check for existing running sync on mount
  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/sync`)
      .then((res) => res.json())
      .then((job) => {
        if (job && (job.status === "pending" || job.status === "running")) {
          setSyncJob(job);
          startPolling(job.id);
        }
      });
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  const startPolling = (jobId: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/workspaces/${workspace.id}/sync?job_id=${jobId}`);
      const job = await res.json();
      setSyncJob(job);

      if (job.status === "completed" || job.status === "failed") {
        stopPolling();
        if (job.status === "completed") fetchCustomers();
      }
    }, 3000);
  };

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const handleSync = async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/sync`, {
      method: "POST",
    });
    const data = await res.json();

    if (res.status === 409) {
      // Already running, start polling it
      startPolling(data.job_id);
      return;
    }

    if (res.ok) {
      setSyncJob({
        id: data.job_id,
        status: "pending",
        phase: null,
        total_customers: 0,
        synced_customers: 0,
        total_orders: 0,
        synced_orders: 0,
        error: null,
      });
      startPolling(data.job_id);
    }
  };

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
    setAppliedSearch(search);
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const isSyncing = syncJob && (syncJob.status === "pending" || syncJob.status === "running");

  // Progress calculation
  let progressPercent = 0;
  let progressLabel = "";

  if (syncJob) {
    if (syncJob.status === "pending") {
      progressLabel = "Starting sync...";
    } else if (syncJob.status === "running" && syncJob.phase === "customers" && syncJob.synced_orders === 0) {
      progressPercent = syncJob.total_customers > 0
        ? Math.round((syncJob.synced_customers / syncJob.total_customers) * 50)
        : 0;
      progressLabel = `Syncing customers: ${syncJob.synced_customers.toLocaleString()} / ${syncJob.total_customers.toLocaleString()}`;
    } else if (syncJob.status === "running" && (syncJob.phase === "orders" || syncJob.synced_orders > 0)) {
      const orderTotal = Math.max(syncJob.total_orders, syncJob.synced_orders);
      progressPercent = orderTotal > 0
        ? 50 + Math.round((syncJob.synced_orders / orderTotal) * 45)
        : 50;
      progressLabel = `Syncing orders: ${syncJob.synced_orders.toLocaleString()} / ${orderTotal.toLocaleString()}`;
    } else if (syncJob.status === "running" && syncJob.phase === "finalizing") {
      progressPercent = 95;
      progressLabel = "Calculating retention scores...";
    } else if (syncJob.status === "completed") {
      progressPercent = 100;
      progressLabel = `Done! ${syncJob.synced_customers.toLocaleString()} customers, ${syncJob.synced_orders.toLocaleString()} orders synced.`;
    } else if (syncJob.status === "failed") {
      progressLabel = syncJob.error || "Sync failed";
    }
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
        {isSyncing ? (
          <span className="text-sm text-zinc-400">Syncing...</span>
        ) : syncJob?.status === "completed" ? (
          <span className="text-xs text-zinc-400">
            Synced {syncJob.synced_customers?.toLocaleString()} customers, {syncJob.synced_orders?.toLocaleString()} orders
          </span>
        ) : total === 0 ? (
          <button
            onClick={handleSync}
            className="cursor-pointer rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
          >
            Sync Customers
          </button>
        ) : null}
      </div>

      {/* ── Progress Bar ── */}
      {syncJob && syncJob.status !== "pending" && (
        <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between text-sm">
            <span className={syncJob.status === "failed" ? "text-red-500" : "text-zinc-700 dark:text-zinc-300"}>
              {progressLabel}
            </span>
            {syncJob.status !== "failed" && (
              <span className="text-xs text-zinc-400">{progressPercent}%</span>
            )}
          </div>
          {syncJob.status !== "failed" && (
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div
                className={`h-full rounded-full transition-all duration-700 ${
                  syncJob.status === "completed"
                    ? "bg-emerald-500"
                    : "bg-indigo-500"
                }`}
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          )}
          {(syncJob.status === "completed" || syncJob.status === "failed") && (
            <button
              onClick={() => setSyncJob(null)}
              className="mt-2 text-xs text-zinc-400 hover:text-zinc-600"
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* ── Pending state ── */}
      {syncJob?.status === "pending" && (
        <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <div className="h-2 w-full animate-pulse rounded-full bg-indigo-200 dark:bg-indigo-900" />
          </div>
          <p className="mt-2 text-xs text-zinc-400">Starting background sync...</p>
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
            placeholder="Search by email or name... (press Enter)"
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
