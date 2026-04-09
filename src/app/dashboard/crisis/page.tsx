"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface CrisisEvent {
  id: string;
  name: string;
  status: string;
  affected_product_title: string | null;
  affected_variant_id: string;
  expected_restock_date: string | null;
  created_at: string;
  counts: {
    total: number;
    tier1_accepted: number;
    tier2_accepted: number;
    tier3_accepted: number;
    cancelled: number;
  };
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  paused: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  resolved: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
};

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function CrisisListPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const [crises, setCrises] = useState<CrisisEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const isAdmin = workspace.role === "owner" || workspace.role === "admin";

  const fetchCrises = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/crisis`);
    if (res.ok) {
      const data = await res.json();
      setCrises(data.crises || []);
    }
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => { fetchCrises(); }, [fetchCrises]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Crisis Management</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Proactive retention campaigns for out-of-stock situations
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => router.push("/dashboard/crisis/new")}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
          >
            New Crisis
          </button>
        )}
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase text-zinc-400 dark:border-zinc-800">
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Affected Item</th>
                <th className="px-4 py-2.5">Customers</th>
                <th className="px-4 py-2.5">Restock Date</th>
                <th className="px-4 py-2.5">Created</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-zinc-400">Loading...</td></tr>
              ) : crises.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-zinc-400">No crisis events found</td></tr>
              ) : (
                crises.map(c => (
                  <tr
                    key={c.id}
                    onClick={() => router.push(`/dashboard/crisis/${c.id}`)}
                    className="cursor-pointer border-b border-zinc-50 transition-colors hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/30"
                  >
                    <td className="px-4 py-2.5 font-medium text-zinc-900 dark:text-zinc-100">
                      {c.name}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_COLORS[c.status] || STATUS_COLORS.draft}`}>
                        {c.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                      {c.affected_product_title || c.affected_variant_id}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-zinc-600 dark:text-zinc-400">
                      {c.counts.total}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-zinc-400">
                      {c.expected_restock_date ? formatDate(c.expected_restock_date) : "---"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-zinc-400">
                      {formatDate(c.created_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
