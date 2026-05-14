"use client";

/**
 * Text campaign detail view. Shows the campaign config + live stats
 * and exposes pause/resume/cancel/delete actions based on status.
 *
 * Timezone source breakdown is the most useful audit: if a big chunk
 * of recipients is in the 'fallback' bucket, it tells us our customer
 * data coverage is weak and we should run the Klaviyo profile
 * enrichment job before the next campaign.
 */

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface Campaign {
  id: string;
  name: string;
  status: string;
  message_body: string;
  media_url: string | null;
  send_date: string;
  target_local_hour: number;
  fallback_timezone: string;
  audience_filter: Record<string, unknown>;
  recipients_total: number;
  recipients_sent: number;
  recipients_failed: number;
  recipients_skipped: number;
  scheduled_at: string | null;
  first_send_at: string | null;
  last_send_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-700",
  scheduled: "bg-amber-100 text-amber-800",
  sending: "bg-blue-100 text-blue-800",
  sent: "bg-emerald-100 text-emerald-800",
  paused: "bg-zinc-200 text-zinc-700",
  cancelled: "bg-rose-100 text-rose-700",
};

const TZ_SOURCE_LABEL: Record<string, string> = {
  customer_explicit: "Customer record",
  address_zip: "Shipping address",
  phone_area_code: "Phone area code",
  fallback: "Workspace fallback",
};

export default function TextCampaignDetailPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [tzBreakdown, setTzBreakdown] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/sms-campaigns/${id}`);
    if (res.ok) {
      const d = await res.json();
      setCampaign(d.campaign);
      setTzBreakdown(d.tz_source_breakdown || {});
    }
    setLoading(false);
  }, [workspace.id, id]);

  useEffect(() => { load(); }, [load]);

  // Poll while sending to surface progress.
  useEffect(() => {
    if (!campaign) return;
    if (campaign.status !== "sending" && campaign.status !== "scheduled") return;
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, [campaign, load]);

  async function action(name: string) {
    setBusy(name);
    setError(null);
    const res = await fetch(`/api/workspaces/${workspace.id}/sms-campaigns/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: name }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || `${name} failed`);
    }
    setBusy(null);
    await load();
  }

  async function deleteCampaign() {
    if (!confirm("Delete this draft campaign?")) return;
    setBusy("delete");
    const res = await fetch(`/api/workspaces/${workspace.id}/sms-campaigns/${id}`, {
      method: "DELETE",
    });
    if (res.ok) router.push("/dashboard/marketing/text");
    else setBusy(null);
  }

  if (loading) return <div className="p-6 text-sm text-zinc-400">Loading…</div>;
  if (!campaign) return <div className="p-6 text-sm text-rose-600">Not found.</div>;

  const progressPct = campaign.recipients_total > 0
    ? Math.round((campaign.recipients_sent / campaign.recipients_total) * 100)
    : 0;

  const totalResolved = Object.values(tzBreakdown).reduce((s, n) => s + n, 0);
  const fallbackCount = tzBreakdown.fallback || 0;
  const fallbackPct = totalResolved > 0 ? (fallbackCount / totalResolved) * 100 : 0;

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <Link href="/dashboard/marketing/text" className="mb-4 inline-flex text-sm text-zinc-500 hover:text-zinc-700">
        &larr; All campaigns
      </Link>

      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{campaign.name}</h1>
            <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_STYLES[campaign.status]}`}>
              {campaign.status}
            </span>
          </div>
          <p className="mt-1 text-sm text-zinc-500">
            {campaign.send_date} at {String(campaign.target_local_hour).padStart(2, "0")}:00 in each recipient&apos;s local time.
          </p>
        </div>
        <ActionButtons status={campaign.status} busy={busy} onAction={action} onDelete={deleteCampaign} />
      </header>

      {error && (
        <p className="mb-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <StatCard label="Audience" value={campaign.recipients_total.toLocaleString()} />
        <StatCard label="Sent" value={campaign.recipients_sent.toLocaleString()} tone="good" />
        <StatCard label="Failed" value={campaign.recipients_failed.toLocaleString()} tone={campaign.recipients_failed > 0 ? "bad" : "neutral"} />
        <StatCard label="Progress" value={`${progressPct}%`} />
      </div>

      <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">Message</h2>
        <pre className="whitespace-pre-wrap rounded bg-zinc-50 p-3 font-mono text-sm text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
          {campaign.message_body}
        </pre>
        {campaign.media_url && (
          <div className="mt-3">
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">MMS image</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={campaign.media_url} alt="" className="mt-2 max-h-48 rounded border border-zinc-200" />
          </div>
        )}
      </div>

      {totalResolved > 0 && (
        <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-zinc-500">Timezone resolution</h2>
          <p className="mb-3 text-xs text-zinc-500">
            Where each recipient&apos;s local time came from. High fallback % = poor customer data coverage; consider running the Klaviyo profile enrichment before the next send.
          </p>
          <ul className="space-y-2">
            {Object.entries(tzBreakdown).sort((a, b) => b[1] - a[1]).map(([source, count]) => {
              const pct = (count / totalResolved) * 100;
              return (
                <li key={source} className="text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-700 dark:text-zinc-300">{TZ_SOURCE_LABEL[source] || source}</span>
                    <span className="tabular-nums font-semibold">
                      {count.toLocaleString()} ({pct.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                    <div
                      className={`h-full ${source === "fallback" ? "bg-amber-500" : "bg-emerald-500"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
          {fallbackPct > 25 && (
            <p className="mt-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
              ⚠ {fallbackPct.toFixed(0)}% of recipients are using the workspace fallback timezone ({campaign.fallback_timezone}) — they&apos;ll all blast at the fallback&apos;s local hour, not theirs.
            </p>
          )}
        </div>
      )}

      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">Lifecycle</h2>
        <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <KV label="Created" value={fmtTime(campaign.created_at)} />
          <KV label="Scheduled" value={fmtTime(campaign.scheduled_at)} />
          <KV label="First send" value={fmtTime(campaign.first_send_at)} />
          <KV label="Completed" value={fmtTime(campaign.completed_at)} />
        </dl>
      </div>
    </div>
  );
}

function ActionButtons({
  status,
  busy,
  onAction,
  onDelete,
}: {
  status: string;
  busy: string | null;
  onAction: (a: string) => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex gap-2">
      {status === "draft" && (
        <>
          <button onClick={() => onAction("schedule")} disabled={!!busy}
            className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
            {busy === "schedule" ? "Scheduling…" : "Schedule"}
          </button>
          <button onClick={onDelete} disabled={!!busy}
            className="rounded-md border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50">
            Delete
          </button>
        </>
      )}
      {(status === "scheduled" || status === "sending") && (
        <>
          <button onClick={() => onAction("pause")} disabled={!!busy}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">
            Pause
          </button>
          <button onClick={() => onAction("cancel")} disabled={!!busy}
            className="rounded-md border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50">
            Cancel
          </button>
        </>
      )}
      {status === "paused" && (
        <>
          <button onClick={() => onAction("resume")} disabled={!!busy}
            className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
            Resume
          </button>
          <button onClick={() => onAction("cancel")} disabled={!!busy}
            className="rounded-md border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50">
            Cancel
          </button>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" | "neutral" }) {
  const colorClass = tone === "good" ? "text-emerald-600" : tone === "bad" ? "text-rose-600" : "text-zinc-900 dark:text-zinc-100";
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${colorClass}`}>{value}</p>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-0.5 text-zinc-900 dark:text-zinc-100">{value}</p>
    </div>
  );
}

function fmtTime(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}
