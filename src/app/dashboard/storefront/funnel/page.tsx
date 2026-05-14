"use client";

/**
 * Storefront funnel dashboard. Reads from storefront_events +
 * storefront_sessions via /api/workspaces/[id]/storefront-funnel.
 *
 * The funnel is the canonical 6-step waterfall:
 *   pdp_view → pdp_engaged → pack_selected → customize_view →
 *   checkout_redirect → order_placed.
 *
 * Each row shows distinct sessions that fired that event type at
 * least once in the window, plus consecutive-step conversion %
 * (this step / prior step) and top-of-funnel conversion % (this
 * step / pdp_view). The big drop-off is usually pdp_view → engaged;
 * the money drop-off is engaged → pack_selected.
 */

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface FunnelStepRow {
  step: string;
  sessions: number;
  conv_from_prev_pct: number;
  conv_from_top_pct: number;
  drop_from_prev: number;
}

interface FunnelData {
  range: { start: string; end: string };
  total_sessions: number;
  funnel: FunnelStepRow[];
  topProducts: Array<{ product_id: string; title: string; handle: string | null; pack_selected_count: number }>;
  deviceBreakdown: Array<{ device_type: string; sessions: number }>;
  countryBreakdown: Array<{ ip_country: string; sessions: number }>;
  sourceBreakdown: Array<{ utm_source: string; sessions: number }>;
  recentEvents: Array<{
    id: string;
    event_type: string;
    anonymous_id: string;
    product_id: string | null;
    meta: Record<string, unknown>;
    url: string | null;
    created_at: string;
  }>;
}

type Preset = "today" | "7d" | "30d" | "custom";

function rangeForPreset(p: Preset): { start: string; end: string } {
  const today = new Date().toISOString().slice(0, 10);
  if (p === "today") return { start: today, end: today };
  if (p === "7d") {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 6);
    return { start: d.toISOString().slice(0, 10), end: today };
  }
  if (p === "30d") {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 29);
    return { start: d.toISOString().slice(0, 10), end: today };
  }
  return { start: today, end: today };
}

const STEP_LABELS: Record<string, string> = {
  pdp_view: "PDP visit",
  pdp_engaged: "Engaged",
  pack_selected: "Pack selected",
  customize_view: "Customize page",
  checkout_redirect: "Checkout started",
  order_placed: "Order placed",
};

export default function StorefrontFunnelPage() {
  const workspace = useWorkspace();
  const [preset, setPreset] = useState<Preset>("7d");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [data, setData] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);

  // Seed dates from preset
  useEffect(() => {
    if (preset !== "custom") {
      const r = rangeForPreset(preset);
      setStart(r.start);
      setEnd(r.end);
    }
  }, [preset]);

  const load = useCallback(async () => {
    if (!start || !end) return;
    setLoading(true);
    const url = `/api/workspaces/${workspace.id}/storefront-funnel?start=${start}&end=${end}`;
    const res = await fetch(url);
    if (res.ok) setData(await res.json());
    setLoading(false);
  }, [workspace.id, start, end]);

  useEffect(() => { load(); }, [load]);

  const topOfFunnel = data?.funnel[0]?.sessions ?? 0;
  const orderPlaced = data?.funnel.find(s => s.step === "order_placed")?.sessions ?? 0;
  const overallCvr = topOfFunnel > 0 ? (orderPlaced / topOfFunnel) * 100 : 0;

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Storefront funnel</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Pixel events from the public storefront. Sessions count distinct visitors per step.
          </p>
        </div>
        <DateRangePicker
          preset={preset} setPreset={setPreset}
          start={start} end={end}
          setStart={setStart} setEnd={setEnd}
        />
      </header>

      {loading && !data && (
        <p className="text-sm text-zinc-400">Loading…</p>
      )}

      {data && (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-4">
            <StatCard label="Total sessions" value={data.total_sessions.toLocaleString()} />
            <StatCard label="PDP visits" value={topOfFunnel.toLocaleString()} />
            <StatCard label="Orders" value={orderPlaced.toLocaleString()} />
            <StatCard
              label="Overall conversion"
              value={`${overallCvr.toFixed(2)}%`}
              tone={overallCvr >= 2 ? "good" : "neutral"}
            />
          </div>

          <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500">
              Funnel — {data.range.start} to {data.range.end}
            </h2>
            <FunnelChart funnel={data.funnel} topOfFunnel={topOfFunnel} />
          </section>

          <div className="mb-8 grid gap-4 lg:grid-cols-3">
            <BreakdownCard
              title="Device"
              rows={data.deviceBreakdown.map(d => ({ label: d.device_type, value: d.sessions }))}
            />
            <BreakdownCard
              title="Source"
              rows={data.sourceBreakdown.map(s => ({ label: s.utm_source, value: s.sessions }))}
            />
            <BreakdownCard
              title="Country"
              rows={data.countryBreakdown.map(c => ({ label: c.ip_country, value: c.sessions }))}
            />
          </div>

          <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">
              Top products (by pack_selected)
            </h2>
            {data.topProducts.length === 0 ? (
              <p className="text-xs text-zinc-400">No pack selections in this range yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
                    <th className="py-2 pr-2">Product</th>
                    <th className="py-2 pr-2 text-right">Selections</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topProducts.map(p => (
                    <tr key={p.product_id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                      <td className="py-2 pr-2 text-zinc-900 dark:text-zinc-100">{p.title}</td>
                      <td className="py-2 pr-2 text-right font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                        {p.pack_selected_count.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">
              Recent events (last 30)
            </h2>
            {data.recentEvents.length === 0 ? (
              <p className="text-xs text-zinc-400">No events in this range.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
                      <th className="py-2 pr-2">Time</th>
                      <th className="py-2 pr-2">Event</th>
                      <th className="py-2 pr-2">Session</th>
                      <th className="py-2 pr-2">URL</th>
                      <th className="py-2 pr-2">Meta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentEvents.map(e => (
                      <tr key={e.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                        <td className="whitespace-nowrap py-2 pr-2 text-zinc-500">
                          {new Date(e.created_at).toLocaleString()}
                        </td>
                        <td className="py-2 pr-2">
                          <EventChip type={e.event_type} />
                        </td>
                        <td className="py-2 pr-2 font-mono text-[10px] text-zinc-400">
                          {e.anonymous_id.slice(0, 8)}…
                        </td>
                        <td className="max-w-[300px] truncate py-2 pr-2 text-zinc-600 dark:text-zinc-400" title={e.url || ""}>
                          {e.url ? new URL(e.url).pathname + new URL(e.url).search : "—"}
                        </td>
                        <td className="max-w-[300px] truncate py-2 pr-2 font-mono text-[10px] text-zinc-500" title={JSON.stringify(e.meta)}>
                          {e.meta && Object.keys(e.meta).length > 0 ? JSON.stringify(e.meta) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function DateRangePicker({
  preset, setPreset, start, end, setStart, setEnd,
}: {
  preset: Preset; setPreset: (p: Preset) => void;
  start: string; end: string;
  setStart: (s: string) => void; setEnd: (s: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-md border border-zinc-200 bg-white p-0.5 dark:border-zinc-700 dark:bg-zinc-900">
        {(["today", "7d", "30d", "custom"] as Preset[]).map(p => (
          <button
            key={p}
            onClick={() => setPreset(p)}
            className={`rounded px-3 py-1.5 text-xs font-semibold transition-colors ${
              preset === p
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            {p === "7d" ? "7 days" : p === "30d" ? "30 days" : p[0].toUpperCase() + p.slice(1)}
          </button>
        ))}
      </div>
      {preset === "custom" && (
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <span className="text-xs text-zinc-500">to</span>
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "good" | "neutral" }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${tone === "good" ? "text-emerald-600" : "text-zinc-900 dark:text-zinc-100"}`}>
        {value}
      </p>
    </div>
  );
}

function FunnelChart({ funnel, topOfFunnel }: { funnel: FunnelStepRow[]; topOfFunnel: number }) {
  return (
    <div className="space-y-1.5">
      {funnel.map((row, i) => {
        const pctOfTop = topOfFunnel > 0 ? (row.sessions / topOfFunnel) * 100 : 0;
        const isFirst = i === 0;
        const isLast = i === funnel.length - 1;
        const dropPct = isFirst ? null : 100 - row.conv_from_prev_pct;
        return (
          <div key={row.step}>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                {STEP_LABELS[row.step] || row.step}
              </span>
              <div className="flex items-center gap-4 tabular-nums">
                <span className="text-zinc-900 dark:text-zinc-100 font-semibold">
                  {row.sessions.toLocaleString()}
                </span>
                {!isFirst && (
                  <span className="text-xs text-zinc-500" title="Conversion from previous step">
                    {row.conv_from_prev_pct.toFixed(1)}% from prev
                  </span>
                )}
                {!isFirst && (
                  <span className="text-xs text-zinc-400" title="Conversion from top of funnel">
                    {row.conv_from_top_pct.toFixed(1)}% from top
                  </span>
                )}
              </div>
            </div>
            <div className="mt-1 h-7 w-full overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
              <div
                className={`h-full rounded transition-all ${
                  isLast ? "bg-emerald-500" : "bg-zinc-900 dark:bg-zinc-100"
                }`}
                style={{ width: `${Math.max(pctOfTop, 0.5)}%` }}
              />
            </div>
            {!isFirst && row.drop_from_prev > 0 && (
              <p className="mt-0.5 text-[11px] text-rose-600">
                ↓ {row.drop_from_prev.toLocaleString()} dropped ({dropPct?.toFixed(1)}%)
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BreakdownCard({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; value: number }>;
}) {
  const max = rows[0]?.value || 1;
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-zinc-400">No data.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.slice(0, 6).map((r) => (
            <li key={r.label} className="text-xs">
              <div className="flex items-center justify-between">
                <span className="truncate text-zinc-700 dark:text-zinc-300">{r.label}</span>
                <span className="ml-2 tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">{r.value}</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                <div className="h-full bg-zinc-900 dark:bg-zinc-100" style={{ width: `${(r.value / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EventChip({ type }: { type: string }) {
  const tone: Record<string, string> = {
    pdp_view: "bg-zinc-100 text-zinc-700",
    pdp_engaged: "bg-amber-100 text-amber-800",
    pack_selected: "bg-blue-100 text-blue-800",
    customize_view: "bg-indigo-100 text-indigo-800",
    upsell_added: "bg-emerald-100 text-emerald-800",
    upsell_skipped: "bg-zinc-100 text-zinc-600",
    checkout_redirect: "bg-violet-100 text-violet-800",
    order_placed: "bg-emerald-200 text-emerald-900 font-bold",
  };
  return (
    <span className={`inline-flex whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone[type] || "bg-zinc-100 text-zinc-700"}`}>
      {type}
    </span>
  );
}
