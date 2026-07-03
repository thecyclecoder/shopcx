"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface CsatResponse {
  id: string;
  rating: number;
  comment: string | null;
  submitted_at: string;
  points_awarded: number;
  ticket_id: string;
  ticket_subject: string | null;
  customer_name: string | null;
  excluded_at: string | null;
  exclusion_reason: string | null;
}

interface CsatStats {
  count: number;
  avg_rating: number;
  by_rating: Record<string, number>;
  sent: number;
  response_rate: number;
  reopened: number;
  reopen_rate: number;
}

const WINDOWS = [7, 30, 90, 365] as const;

export default function CsatPage() {
  const router = useRouter();
  const { id: workspaceId, role } = useWorkspace();
  const isOwner = role === "owner";
  const [days, setDays] = useState<number>(30);
  const [stats, setStats] = useState<CsatStats | null>(null);
  const [responses, setResponses] = useState<CsatResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingTicketFor, setCreatingTicketFor] = useState<string | null>(null);
  const [togglingExcludeFor, setTogglingExcludeFor] = useState<string | null>(null);

  async function createTicketFromCsat(csatId: string) {
    setCreatingTicketFor(csatId);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/csat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create_ticket", csat_id: csatId }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || "Failed to create ticket"); return; }
      router.push(`/dashboard/tickets/${data.ticket_id}`);
    } finally {
      setCreatingTicketFor(null);
    }
  }

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    const res = await fetch(`/api/workspaces/${workspaceId}/csat?days=${days}`);
    if (!res.ok) { setLoading(false); return; }
    const data = await res.json();
    setStats(data.stats);
    setResponses(data.responses || []);
    setLoading(false);
  }, [workspaceId, days]);

  async function toggleExclude(r: CsatResponse) {
    if (!isOwner) return;
    const excluding = r.excluded_at == null;
    let reason: string | null = null;
    if (excluding) {
      const entered = window.prompt("Why exclude this CSAT from the stats? (e.g. product complaint, not service)");
      if (entered == null) return;
      reason = entered.trim();
    }
    setTogglingExcludeFor(r.id);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/csat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          excluding
            ? { action: "exclude", csat_id: r.id, reason }
            : { action: "include", csat_id: r.id },
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert(data.error || "Failed to update"); return; }
      await load();
    } finally {
      setTogglingExcludeFor(null);
    }
  }

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">CSAT</h1>
          <p className="mt-1 text-sm text-zinc-500">Customer-satisfaction scores from closed tickets. Score collected only when the customer confirmed their issue was resolved.</p>
        </div>
        <div className="flex gap-1.5">
          {WINDOWS.map(w => (
            <button
              key={w}
              type="button"
              onClick={() => setDays(w)}
              className={`rounded-md border px-3 py-1 text-xs font-medium transition ${
                days === w
                  ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                  : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      {loading || !stats ? (
        <p className="mt-8 text-sm text-zinc-500">Loading…</p>
      ) : stats.count === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center dark:border-zinc-700 dark:bg-zinc-900">
          <p className="text-sm text-zinc-500">No CSAT responses yet in this window.</p>
          {stats.sent > 0 && (
            <p className="mt-1 text-xs text-zinc-400">{stats.sent} survey{stats.sent === 1 ? "" : "s"} sent — waiting on customer responses.</p>
          )}
        </div>
      ) : (
        <>
          {/* Headline stats */}
          <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Avg rating" value={stats.avg_rating.toFixed(2)} suffix="/ 5" tone={stats.avg_rating >= 4.5 ? "emerald" : stats.avg_rating >= 3.5 ? "blue" : stats.avg_rating >= 2.5 ? "amber" : "red"} />
            <Stat label="Responses" value={stats.count.toString()} />
            <Stat label="Response rate" value={`${(stats.response_rate * 100).toFixed(0)}%`} suffix={`of ${stats.sent} sent`} />
            <Stat label="Reopen rate" value={`${(stats.reopen_rate * 100).toFixed(0)}%`} suffix={`${stats.reopened} reopened`} tone={stats.reopen_rate > 0.15 ? "red" : "default"} />
          </div>

          {/* Histogram */}
          <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Rating distribution</h2>
            <div className="mt-3 space-y-2">
              {[5, 4, 3, 2, 1].map(n => {
                const cnt = stats.by_rating[String(n)] || 0;
                const pct = stats.count ? (cnt / stats.count) * 100 : 0;
                const color = n >= 4 ? "bg-emerald-500" : n === 3 ? "bg-amber-500" : "bg-red-500";
                return (
                  <div key={n} className="flex items-center gap-3 text-xs">
                    <span className="w-4 font-medium text-zinc-700 dark:text-zinc-300">{n}</span>
                    <div className="relative h-5 flex-1 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                      <div className={`absolute inset-y-0 left-0 ${color}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-20 text-right text-zinc-500">{cnt} ({pct.toFixed(0)}%)</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Recent responses */}
          <div className="mt-6 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="border-b border-zinc-100 p-4 text-sm font-medium text-zinc-900 dark:border-zinc-800 dark:text-zinc-100">Recent responses</h2>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {responses.map(r => {
                const excluded = r.excluded_at != null;
                return (
                <li key={r.id} className={`p-4 ${excluded ? "opacity-60" : ""}`}>
                  <div className="flex items-start gap-3">
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base font-semibold ${
                      r.rating >= 4 ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400" :
                      r.rating === 3 ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400" :
                      "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                    }`}>{r.rating}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <Link href={`/dashboard/tickets/${r.ticket_id}`} className="truncate text-sm font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100 dark:hover:text-indigo-400">
                          {r.ticket_subject || "(no subject)"}
                        </Link>
                        <span className="shrink-0 text-[11px] text-zinc-500">{new Date(r.submitted_at).toLocaleString()}</span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-zinc-500">
                        {r.customer_name || "(no customer)"}
                        {r.points_awarded > 0 && <span className="ml-2">· +{r.points_awarded} pts</span>}
                      </p>
                      {excluded && (
                        <p
                          className="mt-1 inline-block rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                          title={r.exclusion_reason || "No reason recorded"}
                        >
                          Excluded from stats{r.exclusion_reason ? ` · ${r.exclusion_reason}` : ""}
                        </p>
                      )}
                      {r.comment && (
                        <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">{r.comment}</p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={creatingTicketFor === r.id}
                          onClick={() => createTicketFromCsat(r.id)}
                          className="rounded-md border border-blue-300 px-2 py-1 text-[11px] font-medium text-blue-700 transition hover:bg-blue-50 disabled:opacity-50 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-950"
                          title={r.comment ? "Use the CSAT comment as the first inbound message" : "Start a fresh ticket on this customer — empty, agent opens the conversation"}
                        >
                          {creatingTicketFor === r.id
                            ? "Creating…"
                            : r.comment
                              ? "Create ticket from this comment"
                              : "Create ticket for this customer"}
                        </button>
                        {isOwner && (
                          <button
                            type="button"
                            disabled={togglingExcludeFor === r.id}
                            onClick={() => toggleExclude(r)}
                            className="rounded-md border border-zinc-300 px-2 py-1 text-[11px] font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                            title={excluded ? "Add this CSAT back into the stats" : "Drop this CSAT from Avg rating + Responses (owner only)"}
                          >
                            {togglingExcludeFor === r.id
                              ? "Saving…"
                              : excluded
                                ? "Include"
                                : "Exclude from stats"}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, suffix, tone }: { label: string; value: string; suffix?: string; tone?: "emerald" | "blue" | "amber" | "red" | "default" }) {
  const toneClass =
    tone === "emerald" ? "text-emerald-600 dark:text-emerald-400" :
    tone === "blue" ? "text-blue-600 dark:text-blue-400" :
    tone === "amber" ? "text-amber-600 dark:text-amber-400" :
    tone === "red" ? "text-red-600 dark:text-red-400" :
    "text-zinc-900 dark:text-zinc-100";
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${toneClass}`}>
        {value}
        {suffix && <span className="ml-1 text-xs font-normal text-zinc-500">{suffix}</span>}
      </p>
    </div>
  );
}
