"use client";

/**
 * Text marketing — campaign list view.
 *
 * Shows recent campaigns with status, audience count, send progress,
 * and the local send time. Click into a campaign for the detail view
 * + actions. "New campaign" CTA opens the builder.
 */

import { useCallback, useEffect, useState } from "react";
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

interface KlaviyoHistoryRow {
  id: string;
  klaviyo_campaign_id: string;
  name: string;
  status: string | null;
  send_time: string | null;
  recipients: number | null;
  delivered: number | null;
  delivery_rate: number | null;
  clicks: number | null;
  click_rate: number | null;
  conversions: number | null;
  conversion_rate: number | null;
  conversion_value_cents: number | null;
  average_order_value_cents: number | null;
  unsubscribe_rate: number | null;
  audience_included: string[];
}

type HistorySort = "send_time" | "conversion_rate" | "conversion_value_cents" | "click_rate" | "recipients";

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

  // Klaviyo history state
  const [history, setHistory] = useState<KlaviyoHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historySort, setHistorySort] = useState<HistorySort>("send_time");
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/sms-campaigns`)
      .then((r) => r.json())
      .then((d) => setCampaigns(d.campaigns || []))
      .finally(() => setLoading(false));
  }, [workspace.id]);

  const loadHistory = useCallback(async (sort: HistorySort) => {
    setHistoryLoading(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/klaviyo-sms-history?sort=${sort}&dir=desc&limit=200`);
    if (res.ok) {
      const d = await res.json();
      setHistory(d.campaigns || []);
    }
    setHistoryLoading(false);
  }, [workspace.id]);

  useEffect(() => { loadHistory(historySort); }, [loadHistory, historySort]);

  async function startImport() {
    setImporting(true);
    setImportMessage(null);
    const res = await fetch(`/api/workspaces/${workspace.id}/klaviyo-sms-import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history_days: 200 }),
    });
    if (res.ok) {
      setImportMessage("Import started — runs in background. Refresh in a minute.");
      // Best-effort: re-poll the table after a short delay so the
      // first few rows appear without a manual refresh.
      setTimeout(() => loadHistory(historySort), 30_000);
    } else {
      const d = await res.json().catch(() => ({}));
      setImportMessage(d.error || "Import failed to start");
    }
    setImporting(false);
  }

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

      <h2 className="mt-2 mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">Your campaigns</h2>

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

      {/* ── Klaviyo history ─────────────────────────────────────── */}
      <div className="mt-12 mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Klaviyo history</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Imported SMS campaign performance from Klaviyo — last ~6 months. Used as the historical baseline for AI segment recommendations.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {importMessage && <span className="text-xs text-emerald-600">{importMessage}</span>}
          <button
            onClick={startImport}
            disabled={importing}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          >
            {importing ? "Starting…" : history.length === 0 ? "Import history" : "Re-sync"}
          </button>
        </div>
      </div>

      {historyLoading ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : history.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-10 text-center dark:border-zinc-700 dark:bg-zinc-900">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">No imported Klaviyo campaigns yet.</p>
          <p className="mt-1 text-xs text-zinc-500">
            Click <strong>Import history</strong> to pull the last 6 months of SMS sends.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
                <SortableTh label="Campaign" field="send_time" current={historySort} setSort={setHistorySort} disabled />
                <SortableTh label="Sent" field="send_time" current={historySort} setSort={setHistorySort} />
                <SortableTh label="Recipients" field="recipients" current={historySort} setSort={setHistorySort} />
                <SortableTh label="CTR" field="click_rate" current={historySort} setSort={setHistorySort} />
                <SortableTh label="Conversions" field="conversion_rate" current={historySort} setSort={setHistorySort} />
                <SortableTh label="Revenue" field="conversion_value_cents" current={historySort} setSort={setHistorySort} />
                <th className="px-4 py-3">AOV</th>
              </tr>
            </thead>
            <tbody>
              {history.map((c) => (
                <tr key={c.id} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/50">
                  <td className="px-4 py-3">
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">{c.name}</span>
                    <p className="mt-0.5 text-[10px] font-mono text-zinc-400">{c.klaviyo_campaign_id}</p>
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                    {c.send_time ? new Date(c.send_time).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
                    {c.recipients?.toLocaleString() || "—"}
                  </td>
                  <td className="px-4 py-3 text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
                    {c.click_rate != null ? `${(c.click_rate * 100).toFixed(2)}%` : "—"}
                    {c.clicks != null && c.clicks > 0 && (
                      <span className="ml-1 text-[10px] text-zinc-400">({c.clicks.toLocaleString()})</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs tabular-nums">
                    <span className="text-zinc-900 dark:text-zinc-100">{c.conversions?.toLocaleString() || 0}</span>
                    {c.conversion_rate != null && (
                      <span className="ml-1 text-[10px] text-zinc-500">
                        ({(c.conversion_rate * 100).toFixed(2)}%)
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs tabular-nums font-semibold text-emerald-700 dark:text-emerald-400">
                    {c.conversion_value_cents != null ? `$${(c.conversion_value_cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
                    {c.average_order_value_cents != null ? `$${(c.average_order_value_cents / 100).toFixed(2)}` : "—"}
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

function SortableTh({
  label, field, current, setSort, disabled,
}: {
  label: string;
  field: HistorySort;
  current: HistorySort;
  setSort: (s: HistorySort) => void;
  disabled?: boolean;
}) {
  if (disabled) return <th className="px-4 py-3">{label}</th>;
  const active = field === current;
  return (
    <th className="px-4 py-3">
      <button
        onClick={() => setSort(field)}
        className={`inline-flex items-center gap-1 ${active ? "text-zinc-900 dark:text-zinc-100" : "hover:text-zinc-700"}`}
      >
        {label}
        {active && <span className="text-[8px]">▼</span>}
      </button>
    </th>
  );
}
