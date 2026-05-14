"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface BannedRow {
  id: string;
  meta_sender_id: string;
  sender_name: string | null;
  sender_username: string | null;
  reason: string | null;
  banned_at: string;
  banned_by: string | null;
  comment_count: number;
}

export default function BannedUsersPage() {
  const { id: workspaceId } = useWorkspace();
  const [rows, setRows] = useState<BannedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/workspaces/${workspaceId}/banned-meta-users`);
    const data = await res.json();
    setRows(data.banned || []);
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function unban(row: BannedRow) {
    if (!confirm(`Unban ${row.sender_name || row.meta_sender_id}? Future comments from this user will be moderated normally.`)) {
      return;
    }
    setSubmittingId(row.meta_sender_id);
    await fetch(`/api/workspaces/${workspaceId}/banned-meta-users/${row.meta_sender_id}`, {
      method: "DELETE",
    });
    await load();
    setSubmittingId(null);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <Link
          href="/dashboard/social-comments"
          className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          ← Back to all comments
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
          Banned users
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Workspace-wide ban list. Every page in this workspace auto-hides comments from these users.
        </p>
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-8 text-center text-sm text-zinc-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500">No banned users.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2 font-medium">User</th>
                <th className="px-4 py-2 font-medium">Banned</th>
                <th className="px-4 py-2 font-medium">Reason</th>
                <th className="px-4 py-2 font-medium">Comments</th>
                <th className="px-4 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr
                  key={row.id}
                  className="border-t border-zinc-200 dark:border-zinc-800"
                >
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {row.sender_name || "(name unknown)"}
                    </div>
                    {row.sender_username && (
                      <div className="text-xs text-zinc-500">@{row.sender_username}</div>
                    )}
                    <div className="mt-1 font-mono text-xs text-zinc-400">{row.meta_sender_id}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-700 dark:text-zinc-300">
                    {new Date(row.banned_at).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </td>
                  <td className="px-4 py-3 max-w-[280px] text-sm text-zinc-600 dark:text-zinc-400">
                    {row.reason || "—"}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <Link
                      href={`/dashboard/social-comments?sender=${encodeURIComponent(row.meta_sender_id)}`}
                      className="text-blue-600 hover:underline"
                    >
                      {row.comment_count} total
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => unban(row)}
                      disabled={submittingId === row.meta_sender_id}
                      className="rounded-md border border-emerald-300 px-3 py-1 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-400"
                    >
                      Unban
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
