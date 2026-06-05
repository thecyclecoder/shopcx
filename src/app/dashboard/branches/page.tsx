"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface Branch {
  number: number;
  title: string;
  url: string;
  branch: string;
  created_at: string;
  ci: string;
  mergeable_state: string;
  changed_files: number | null;
  safe_to_merge: boolean;
  todo_id: string | null;
  todo_summary: string | null;
  action_type: string | null;
}

const CI_BADGE: Record<string, string> = {
  success: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  failure: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
  unknown: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

function age(s: string): string {
  const ms = Date.now() - new Date(s).getTime();
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default function BranchesPage() {
  const workspace = useWorkspace();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch("/api/branches")
      .then((r) => r.json())
      .then((d) => {
        setBranches(d.branches || []);
        setConfigured(d.configured !== false);
      })
      .finally(() => setLoading(false));
  }, [workspace.id]);

  async function squashMerge(number: number) {
    if (!window.confirm("Squash & merge this PR into main? This can't be undone from here.")) return;
    setMerging(number);
    setError(null);
    try {
      const res = await fetch(`/api/branches/${number}/merge`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Merge failed");
      setBranches((bs) => bs.filter((b) => b.number !== number));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Merge failed");
    } finally {
      setMerging(null);
    }
  }

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Branches</h1>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        Open <code>claude/*</code> PRs the To-Do routine has opened. Owners can squash &amp; merge here when a PR is
        conflict-free; otherwise review in GitHub. Code never auto-merges.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900/40 dark:bg-rose-900/20 dark:text-rose-300">
          {error}
        </div>
      )}

      {!configured ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-300">
          GitHub access isn&apos;t configured. Set <code>GITHUB_TOKEN</code> (and optionally <code>AGENT_TODO_REPO</code>) in the
          environment so this surface can list the routine&apos;s open PRs.
        </div>
      ) : loading ? (
        <div className="py-12 text-center text-sm text-zinc-400">Loading…</div>
      ) : branches.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          No open <code>claude/*</code> PRs.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Source todo</th>
                <th className="px-3 py-2 font-medium">Age</th>
                <th className="px-3 py-2 font-medium">CI</th>
                <th className="px-3 py-2 font-medium">Mergeable</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {branches.map((b) => (
                <tr key={b.number} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                  <td className="px-3 py-2 text-zinc-800 dark:text-zinc-200">
                    {b.title}
                    <div className="text-xs text-zinc-400">
                      {b.branch}
                      {b.changed_files != null ? ` · ${b.changed_files} files` : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {b.todo_id ? (
                      <Link href={`/dashboard/tickets/todos/${b.todo_id}`} className="text-zinc-600 hover:underline dark:text-zinc-300">
                        {b.todo_summary || b.action_type}
                      </Link>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-500">{age(b.created_at)}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${CI_BADGE[b.ci] || CI_BADGE.unknown}`}>
                      {b.ci}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs capitalize text-zinc-500">{b.mergeable_state}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    {workspace.role === "owner" && b.safe_to_merge && (
                      <button
                        onClick={() => squashMerge(b.number)}
                        disabled={merging === b.number}
                        className="mr-3 rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        {merging === b.number ? "Merging…" : "Squash & merge"}
                      </button>
                    )}
                    <a href={b.url} target="_blank" rel="noopener noreferrer" className="text-xs text-teal-600 hover:underline">
                      Open in GitHub ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
