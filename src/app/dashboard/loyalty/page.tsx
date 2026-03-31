"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface LoyaltyMember {
  id: string;
  email: string | null;
  points_balance: number;
  points_earned: number;
  points_spent: number;
  updated_at: string | null;
  customer_id: string | null;
  customers: { first_name: string | null; last_name: string | null; email: string | null } | null;
}

const PAGE_SIZE = 25;

export default function LoyaltyPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const [members, setMembers] = useState<LoyaltyMember[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("points_balance");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);

  // Stats
  const [stats, setStats] = useState({
    total_members: 0,
    total_points: 0,
    earned_month: 0,
    avg_points: 0,
  });

  const fetchMembers = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      workspace_id: workspace.id,
      sort,
      order,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (search) params.set("search", search);

    const res = await fetch(`/api/loyalty/members?${params}`);
    if (res.ok) {
      const data = await res.json();
      setMembers(data.members || []);
      setTotal(data.total || 0);
    }
    setLoading(false);
  }, [workspace.id, search, sort, order, offset]);

  useEffect(() => { fetchMembers(); }, [fetchMembers]);

  // Fetch aggregate stats
  useEffect(() => {
    fetch(`/api/loyalty/members?workspace_id=${workspace.id}&limit=250&sort=points_balance&order=desc`)
      .then((r) => r.json())
      .then((d) => {
        const mems: LoyaltyMember[] = d.members || [];
        const totalPts = mems.reduce((sum, m) => sum + m.points_balance, 0);
        const totalEarned = mems.reduce((sum, m) => sum + m.points_earned, 0);
        const avgPts = mems.length > 0 ? Math.round(totalPts / mems.length) : 0;
        setStats({
          total_members: d.total || 0,
          total_points: totalPts,
          earned_month: totalEarned,
          avg_points: avgPts,
        });
      })
      .catch(() => {});
  }, [workspace.id]);

  const handleSort = (col: string) => {
    if (sort === col) {
      setOrder(order === "asc" ? "desc" : "asc");
    } else {
      setSort(col);
      setOrder("desc");
    }
    setOffset(0);
  };

  const SortIcon = ({ col }: { col: string }) => (
    <span className="ml-1 text-zinc-400">
      {sort === col ? (order === "asc" ? "\u2191" : "\u2193") : ""}
    </span>
  );

  const memberName = (m: LoyaltyMember) => {
    if (m.customers?.first_name || m.customers?.last_name) {
      return [m.customers.first_name, m.customers.last_name].filter(Boolean).join(" ");
    }
    return m.email || "Unknown";
  };

  return (
    <div className="px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Loyalty</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Manage loyalty program members, track points, and monitor activity.
        </p>
      </div>

      {/* Stats row */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "Total Members", value: stats.total_members.toLocaleString() },
          { label: "Points Outstanding", value: stats.total_points.toLocaleString() },
          { label: "Total Earned", value: stats.earned_month.toLocaleString() },
          { label: "Avg Points/Member", value: stats.avg_points.toLocaleString() },
        ].map((stat) => (
          <div
            key={stat.label}
            className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <p className="text-sm text-zinc-500">{stat.label}</p>
            <p className="mt-1 text-xl font-bold text-zinc-900 dark:text-zinc-100">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          placeholder="Search by email..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
          className="w-64 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500"
        />
      </div>

      {/* Members table */}
      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-800/50">
              <th className="px-4 py-3 font-medium text-zinc-500">Customer</th>
              <th
                className="cursor-pointer px-4 py-3 font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200"
                onClick={() => handleSort("points_balance")}
              >
                Balance<SortIcon col="points_balance" />
              </th>
              <th
                className="cursor-pointer px-4 py-3 font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200"
                onClick={() => handleSort("points_earned")}
              >
                Earned<SortIcon col="points_earned" />
              </th>
              <th
                className="cursor-pointer px-4 py-3 font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200"
                onClick={() => handleSort("points_spent")}
              >
                Spent<SortIcon col="points_spent" />
              </th>
              <th
                className="cursor-pointer px-4 py-3 font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200"
                onClick={() => handleSort("updated_at")}
              >
                Last Activity<SortIcon col="updated_at" />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-zinc-400">
                  Loading...
                </td>
              </tr>
            ) : members.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-zinc-400">
                  No loyalty members found
                </td>
              </tr>
            ) : (
              members.map((m) => (
                <tr key={m.id} onClick={() => router.push(`/dashboard/loyalty/${m.id}`)} className="cursor-pointer transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  <td className="px-4 py-3">
                    <div>
                      <p className="font-medium text-zinc-900 dark:text-zinc-100">{memberName(m)}</p>
                      <p className="text-sm text-zinc-400">{m.email || m.customers?.email}</p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-semibold text-purple-600 dark:text-purple-400">
                      {m.points_balance.toLocaleString()}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                    {m.points_earned.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                    {m.points_spent.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-400">
                    {m.updated_at ? new Date(m.updated_at).toLocaleDateString() : "\u2014"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-zinc-500">
            Showing {offset + 1}\u2013{Math.min(offset + PAGE_SIZE, total)} of {total}
          </p>
          <div className="flex gap-2">
            <button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              Previous
            </button>
            <button
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
