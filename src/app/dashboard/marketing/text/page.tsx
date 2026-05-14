"use client";

/**
 * Text marketing — campaign list view.
 *
 * Shows recent campaigns with status, audience count, send progress,
 * and the local send time. Click into a campaign for the detail view
 * + actions. "New campaign" CTA opens the builder.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface Campaign {
  id: string;
  name: string;
  status: string;
  message_body: string;
  send_date: string;
  target_local_hour: number;
  fallback_timezone: string;
  recipients_total: number;
  recipients_sent: number;
  recipients_failed: number;
  scheduled_at: string | null;
  completed_at: string | null;
  created_at: string;
}

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-700",
  scheduled: "bg-amber-100 text-amber-800",
  sending: "bg-blue-100 text-blue-800",
  sent: "bg-emerald-100 text-emerald-800",
  paused: "bg-zinc-200 text-zinc-700",
  cancelled: "bg-rose-100 text-rose-700",
};

export default function TextMarketingListPage() {
  const workspace = useWorkspace();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/sms-campaigns`)
      .then((r) => r.json())
      .then((d) => setCampaigns(d.campaigns || []))
      .finally(() => setLoading(false));
  }, [workspace.id]);

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Text marketing</h1>
          <p className="mt-1 text-sm text-zinc-500">
            SMS &amp; MMS campaigns. Each recipient receives the message at the local hour you choose in their timezone.
          </p>
        </div>
        <Link
          href="/dashboard/marketing/text/new"
          className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
        >
          + New campaign
        </Link>
      </header>

      {loading ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : campaigns.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-10 text-center dark:border-zinc-700 dark:bg-zinc-900">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">No campaigns yet.</p>
          <p className="mt-1 text-xs text-zinc-500">
            Start with a small test campaign to a small audience before going wide.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Send date</th>
                <th className="px-4 py-3">Local hour</th>
                <th className="px-4 py-3">Progress</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/50">
                  <td className="px-4 py-3">
                    <Link href={`/dashboard/marketing/text/${c.id}`} className="font-medium text-zinc-900 hover:underline dark:text-zinc-100">
                      {c.name}
                    </Link>
                    <p className="mt-0.5 truncate text-xs text-zinc-500" style={{ maxWidth: 360 }}>
                      {c.message_body.slice(0, 80)}{c.message_body.length > 80 ? "…" : ""}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_STYLES[c.status] || STATUS_STYLES.draft}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">{c.send_date}</td>
                  <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                    {String(c.target_local_hour).padStart(2, "0")}:00 local
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                    {c.recipients_sent.toLocaleString()} / {c.recipients_total.toLocaleString()}
                    {c.recipients_failed > 0 && (
                      <span className="ml-2 text-rose-600">+{c.recipients_failed} failed</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">
                    {new Date(c.created_at).toLocaleDateString()}
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
