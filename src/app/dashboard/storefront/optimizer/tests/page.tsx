"use client";

/**
 * Storefront tests index — every A/B test in the workspace, newest/active first,
 * linking into each detail page (docs/brain/specs/storefront-test-detail-page.md
 * Phase 1).
 *
 * Reads /api/workspaces/[id]/storefront-experiments (owner/admin only).
 */

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface ExperimentListRow {
  id: string;
  product_id: string;
  product_title: string | null;
  product_handle: string | null;
  lander_type: string;
  audience: string;
  lever: string;
  hypothesis: string | null;
  status: string;
  started_at: string | null;
  created_at: string | null;
  arm_count: number;
  sessions: number;
}

const STATUS_STYLE: Record<string, string> = {
  running: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  promoted: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  draft: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  killed: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  rolled_back: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
};

export default function StorefrontTestsIndexPage() {
  const workspace = useWorkspace();
  const [experiments, setExperiments] = useState<ExperimentListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await fetch(`/api/workspaces/${workspace.id}/storefront-experiments`);
    if (res.ok) {
      const data = await res.json();
      setExperiments(Array.isArray(data.experiments) ? data.experiments : []);
    } else if (res.status === 403) {
      setError("Only an owner or admin can view storefront tests.");
    } else {
      setError("Failed to load tests.");
    }
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Storefront tests</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Every A/B test the optimizer is running. Open one to preview both versions and read the
          per-arm funnel. The autonomous bandit still drives promote/kill — this is to observe.
        </p>
        <Link
          href="/dashboard/storefront/optimizer"
          className="mt-2 inline-block text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
        >
          ← Optimizer control surface
        </Link>
      </header>

      {error && (
        <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : experiments.length === 0 ? (
        <p className="text-sm text-zinc-400">No storefront tests yet.</p>
      ) : (
        <ul className="space-y-2">
          {experiments.map((e) => (
            <li key={e.id}>
              <Link
                href={`/dashboard/storefront/optimizer/tests/${e.id}`}
                className="block rounded-lg border border-zinc-200 bg-white p-4 transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/50"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                      STATUS_STYLE[e.status] ?? STATUS_STYLE.draft
                    }`}
                  >
                    {e.status.replace("_", " ")}
                  </span>
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    {e.lander_type}
                  </span>
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                    lever: {e.lever || "—"}
                  </span>
                  {e.product_title && (
                    <span className="ml-auto text-xs text-zinc-500">{e.product_title}</span>
                  )}
                </div>
                {e.hypothesis && (
                  <p className="mt-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">{e.hypothesis}</p>
                )}
                <p className="mt-1 text-xs text-zinc-400">
                  {e.arm_count} arm{e.arm_count === 1 ? "" : "s"} · {e.sessions.toLocaleString()} session
                  {e.sessions === 1 ? "" : "s"}
                  {e.started_at ? ` · started ${new Date(e.started_at).toLocaleDateString()}` : ""}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
