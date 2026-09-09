"use client";

/**
 * Review programme stats — sent → clicked → reviewed.
 *
 * Exists because the 2026-09-08 outage was invisible for eight days: `review_requests` looked
 * perfectly healthy (545 rows, every one `outcome='sent'`) while every magic link 404'd. The
 * dashboard had no surface that would have contradicted it.
 *
 * So the "Deliverable links" figure is first-class here even though it means nothing to a
 * marketer. It should always equal Sent. When it doesn't, that gap IS an outage, and the page
 * says so in words rather than leaving it to be inferred from two numbers that disagree.
 */
import { errText } from "@/lib/error-text";
import { useState, useEffect, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Funnel {
  sent: number; linkable: number; clicked: number; reviewed: number;
  click_rate: number; review_rate: number; dead_links: number;
}
interface Stats {
  window_days: number;
  funnel: Funnel;
  by_day: { date: string; count: number }[];
  by_channel: { channel: string; count: number }[];
  all_time_asks: number;
}

const WINDOWS = [7, 30, 90] as const;

export default function ReviewStatsPage() {
  const workspace = useWorkspace();
  const [stats, setStats] = useState<Stats | null>(null);
  const [days, setDays] = useState<number>(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspace?.id) return;
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspace.id}/reviews/stats?days=${days}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setStats(j as Stats);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [workspace?.id, days]);

  useEffect(() => { void load(); }, [load]);

  const f = stats?.funnel;
  const peak = Math.max(1, ...(stats?.by_day ?? []).map((d) => d.count));

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Review Stats</h1>
          <p className="mt-1 text-sm text-zinc-500">How many asks go out, how many get opened, how many become reviews.</p>
        </div>
        <div className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setDays(w)}
              className={`rounded-md px-3 py-1 text-sm font-medium transition ${
                days === w
                  ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="text-sm text-zinc-500">Loading…</p>}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
          {error}
        </div>
      )}

      {f && !loading && (
        <>
          {/* The alarm comes FIRST when it fires — a dead link cannot be answered, so every
              rate below it is meaningless while this is non-zero. */}
          {f.dead_links > 0 && (
            <div className="mb-5 rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/30">
              <p className="text-sm font-semibold text-red-800 dark:text-red-300">
                {f.dead_links} {f.dead_links === 1 ? "ask has" : "asks have"} a link that cannot resolve
              </p>
              <p className="mt-1 text-sm text-red-700 dark:text-red-400">
                Those customers land on an error page, so they can never review. The rates below are
                measured against everything sent, including these.
              </p>
            </div>
          )}

          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Sent" value={f.sent} hint={`last ${stats.window_days} days`} />
            <Stat
              label="Deliverable links"
              value={f.linkable}
              hint={f.dead_links > 0 ? `${f.dead_links} dead` : "all resolve"}
              tone={f.dead_links > 0 ? "bad" : "good"}
            />
            <Stat label="Clicked" value={f.clicked} hint={`${f.click_rate}% of sent`} />
            <Stat label="Reviews" value={f.reviewed} hint={`${f.review_rate}% of sent`} tone={f.reviewed > 0 ? "good" : undefined} />
          </div>

          <div className="mb-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Funnel</h2>
            <Bar label="Sent" n={f.sent} total={f.sent} />
            <Bar label="Link works" n={f.linkable} total={f.sent} />
            <Bar label="Clicked" n={f.clicked} total={f.sent} />
            <Bar label="Reviewed" n={f.reviewed} total={f.sent} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Sends per day</h2>
              {stats.by_day.length === 0 ? (
                <p className="text-sm text-zinc-500">No asks in this window.</p>
              ) : (
                <div className="flex h-28 items-end gap-1">
                  {stats.by_day.map((d) => (
                    <div key={d.date} className="group relative flex-1" title={`${d.date}: ${d.count}`}>
                      <div
                        className="w-full rounded-t bg-zinc-300 transition group-hover:bg-zinc-400 dark:bg-zinc-700 dark:group-hover:bg-zinc-600"
                        style={{ height: `${Math.max(4, (d.count / peak) * 100)}%` }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Channel</h2>
              {stats.by_channel.map((c) => (
                <div key={c.channel} className="flex items-center justify-between py-1 text-sm">
                  <span className="text-zinc-600 dark:text-zinc-400">{c.channel}</span>
                  <span className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{c.count}</span>
                </div>
              ))}
              <p className="mt-3 border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
                {stats.all_time_asks} asks all time.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: "good" | "bad" }) {
  const colour =
    tone === "bad" ? "text-red-600 dark:text-red-400"
    : tone === "good" ? "text-emerald-600 dark:text-emerald-400"
    : "text-zinc-900 dark:text-zinc-100";
  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${colour}`}>{value.toLocaleString()}</p>
      {hint && <p className="mt-0.5 text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

function Bar({ label, n, total }: { label: string; n: number; total: number }) {
  const pct = total ? (n / total) * 100 : 0;
  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-zinc-600 dark:text-zinc-400">{label}</span>
        <span className="tabular-nums text-zinc-500">{n.toLocaleString()} · {pct.toFixed(1)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div className="h-full rounded-full bg-zinc-400 dark:bg-zinc-600" style={{ width: `${Math.max(pct, n > 0 ? 1 : 0)}%` }} />
      </div>
    </div>
  );
}
