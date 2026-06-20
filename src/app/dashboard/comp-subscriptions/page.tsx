"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import { formatItemName } from "@/components/shared/format-utils";

interface CompSubscription {
  id: string;
  shopify_contract_id: string;
  status: string;
  items: { title?: string; variant_title?: string; quantity?: number }[] | null;
  billing_interval: string | null;
  billing_interval_count: number | null;
  next_billing_date: string | null;
  comp: boolean;
  comp_note: string | null;
  created_at: string;
  customers: {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    comp_role: string | null;
    comp_note: string | null;
  };
}

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  paused: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  cancelled: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  expired: "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500",
};

const ROLE_BADGE: Record<string, string> = {
  employee: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
  influencer: "bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400",
  investor: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  owner: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
};

const ROLE_TABS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "employee", label: "Employees" },
  { key: "influencer", label: "Influencers" },
  { key: "investor", label: "Investors" },
  { key: "owner", label: "Owners" },
];

function formatCadence(interval: string | null, count: number | null): string {
  if (!interval) return "--";
  const n = count || 1;
  return n === 1 ? `every ${interval}` : `every ${n} ${interval}s`;
}

function formatDate(d: string | null): string {
  if (!d) return "--";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function CompSubscriptionsPage() {
  const workspace = useWorkspace();
  const router = useRouter();

  const [subs, setSubs] = useState<CompSubscription[]>([]);
  const [total, setTotal] = useState(0);
  const [roleCounts, setRoleCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  const [role, setRole] = useState("all");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [sort, setSort] = useState("next_billing_date");
  const [order, setOrder] = useState<"asc" | "desc">("asc");

  const fetchSubs = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ sort, order });
    if (role !== "all") params.set("role", role);
    if (appliedSearch) params.set("search", appliedSearch);

    const res = await fetch(`/api/workspaces/${workspace.id}/comp-subscriptions?${params}`);
    if (res.ok) {
      const data = await res.json();
      setSubs(data.subscriptions || []);
      setTotal(data.total || 0);
      setRoleCounts(data.role_counts || {});
    }
    setLoading(false);
  }, [workspace.id, role, appliedSearch, sort, order]);

  useEffect(() => { fetchSubs(); }, [fetchSubs]);

  const handleSort = (col: string) => {
    if (sort === col) setOrder(o => o === "asc" ? "desc" : "asc");
    else { setSort(col); setOrder("asc"); }
  };

  const SortIcon = ({ col }: { col: string }) => (
    sort === col ? <span className="ml-1 text-[10px]">{order === "asc" ? "▲" : "▼"}</span> : null
  );

  const tabCount = (key: string) => {
    if (key === "all") return Object.values(roleCounts).reduce((a, b) => a + b, 0);
    return roleCounts[key] || 0;
  };

  return (
    <div className="mx-auto w-full max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Comp Subscriptions</h1>
        <div className="flex items-center gap-2 text-sm text-zinc-500">{total} shown</div>
      </div>
      <p className="mb-5 max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">
        The free-product roster — every comp subscription ships on schedule for free ($0, no charge).
        Setting a customer&apos;s role adds them to the comp allowlist that gates these renewals.
      </p>

      {/* Role group tabs */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {ROLE_TABS.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setRole(t.key)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
              role === t.key
                ? "bg-indigo-50 font-medium text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {t.label}
            <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-xs tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              {tabCount(t.key)}
            </span>
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <form onSubmit={e => { e.preventDefault(); setAppliedSearch(search); }} className="flex w-full gap-1 sm:w-auto">
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
                <th className="px-4 py-2.5">Role</th>
                <th className="px-4 py-2.5">Note</th>
                <th className="px-4 py-2.5">Products</th>
                <th className="px-4 py-2.5">Cadence</th>
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("next_billing_date")}>Next Ship<SortIcon col="next_billing_date" /></th>
                <th className="cursor-pointer px-4 py-2.5" onClick={() => handleSort("status")}>Status<SortIcon col="status" /></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-zinc-400">Loading...</td></tr>
              ) : subs.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-zinc-400">No comp subscriptions found</td></tr>
              ) : subs.map(sub => {
                const items = sub.items || [];
                const customer = sub.customers;
                const name = `${customer?.first_name || ""} ${customer?.last_name || ""}`.trim() || customer?.email || "";
                const compRole = customer?.comp_role;
                const note = sub.comp_note || customer?.comp_note || "";

                return (
                  <tr key={sub.id}
                    onClick={() => router.push(`/dashboard/subscriptions/${sub.id}`)}
                    className="cursor-pointer border-b border-zinc-50 transition-colors hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/30">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-zinc-900 dark:text-zinc-100">{name}</div>
                      <div className="text-xs text-zinc-400">{customer?.email}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      {compRole ? (
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${ROLE_BADGE[compRole] || "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"}`}>
                          {compRole}
                        </span>
                      ) : (
                        <span className="inline-flex rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-600 dark:bg-red-900/30 dark:text-red-400">
                          not allowlisted
                        </span>
                      )}
                    </td>
                    <td className="max-w-[180px] truncate px-4 py-2.5 text-zinc-500">{note || <span className="text-zinc-300 dark:text-zinc-600">--</span>}</td>
                    <td className="max-w-[220px] truncate px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                      {items.slice(0, 2).map(i => `${formatItemName(i)}${i.quantity && i.quantity > 1 ? ` ×${i.quantity}` : ""}`).join(", ")}
                      {items.length > 2 && <span className="text-zinc-400"> +{items.length - 2}</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-zinc-500">{formatCadence(sub.billing_interval, sub.billing_interval_count)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-zinc-500">{formatDate(sub.next_billing_date)}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[sub.status] || STATUS_BADGE.active}`}>
                        {sub.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
