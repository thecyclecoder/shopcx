"use client";

/**
 * Ad & Lander Quality Scorecard. Reads /api/workspaces/[id]/ad-scorecard.
 *
 * Two lenses on the same real-session data (internal/bot excluded):
 *   - Ad creative  → which ad sends the most engaged / ATC / lead / buying traffic
 *   - Lander       → which lander variant converts that traffic best
 *
 * Rates are over PDP visitors (the cohort the ad delivered). Ad purchases are
 * first-touch (orders.attributed_utm_campaign); lander purchases are
 * session-scoped (order_placed). See the spec for the attribution rationale.
 */

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface AdRow {
  campaign: string;
  meta_ad_id: string | null;
  sources: string[];
  known_creative: boolean;
  meets_min_volume: boolean;
  sessions: number;
  engaged: number;
  engaged_rate_pct: number;
  add_to_cart: number;
  atc_rate_pct: number;
  checkout: number;
  leads: number;
  lead_rate_pct: number;
  purchases: number;
  revenue_cents: number;
  cvr_pct: number;
  quality_score: number;
}

interface LanderRow {
  variant: string;
  angle: string | null;
  path: string | null;
  publication: string | null;
  headline: string | null;
  meets_min_volume: boolean;
  sessions: number;
  engaged: number;
  engaged_rate_pct: number;
  add_to_cart: number;
  atc_rate_pct: number;
  checkout: number;
  leads: number;
  lead_rate_pct: number;
  purchases: number;
  revenue_cents: number;
  cvr_pct: number;
  quality_score: number;
}

interface ScorecardData {
  range: { start: string; end: string };
  min_sessions: number;
  cohort_sessions: number;
  ads: AdRow[];
  landers: LanderRow[];
}

type Preset = "today" | "7d" | "30d" | "custom";
type AdSortKey = "sessions" | "engaged_rate_pct" | "atc_rate_pct" | "lead_rate_pct" | "cvr_pct" | "revenue_cents" | "quality_score";

function todayCentral(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}
function daysAgoCentral(n: number): string {
  const today = todayCentral();
  const [y, m, d] = today.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d - n, 12));
  return noon.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}
function rangeForPreset(p: Preset): { start: string; end: string } {
  const today = todayCentral();
  if (p === "today") return { start: today, end: today };
  if (p === "7d") return { start: daysAgoCentral(6), end: today };
  if (p === "30d") return { start: daysAgoCentral(29), end: today };
  return { start: today, end: today };
}
function money(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export default function AdScorecardPage() {
  const workspace = useWorkspace();
  const [preset, setPreset] = useState<Preset>("30d");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [minSessions, setMinSessions] = useState(1);
  const [data, setData] = useState<ScorecardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [adSort, setAdSort] = useState<AdSortKey>("sessions");

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
    const url = `/api/workspaces/${workspace.id}/ad-scorecard?start=${start}&end=${end}&min=${minSessions}`;
    const res = await fetch(url);
    if (res.ok) setData(await res.json());
    setLoading(false);
  }, [workspace.id, start, end, minSessions]);

  useEffect(() => { load(); }, [load]);

  const ads = (data?.ads ?? []).filter(a => a.meets_min_volume);
  const landers = (data?.landers ?? []).filter(l => l.meets_min_volume);
  const sortedAds = [...ads].sort((a, b) => (b[adSort] as number) - (a[adSort] as number));
  const hiddenAds = (data?.ads.length ?? 0) - ads.length;
  const hiddenLanders = (data?.landers.length ?? 0) - landers.length;

  return (
    <div className="mx-auto w-full max-w-screen-2xl overflow-x-hidden px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Ad & Lander Scorecard</h1>
          <p className="mt-1 max-w-3xl text-sm text-zinc-500">
            Which ads send <strong>quality</strong> traffic, and which landers convert it. Grouped from real storefront
            sessions (internal/bot excluded). Rates are over PDP visitors. Ad purchases are first-touch attributed;
            lander purchases are session-scoped.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MinVolumePicker value={minSessions} onChange={setMinSessions} />
          <DateRangePicker
            preset={preset} setPreset={setPreset}
            start={start} end={end} setStart={setStart} setEnd={setEnd}
          />
        </div>
      </header>

      {loading && !data && <p className="text-sm text-zinc-400">Loading…</p>}

      {data && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="PDP visitors (cohort)" value={data.cohort_sessions.toLocaleString()} />
            <StatCard label="Ad creatives" value={ads.length.toLocaleString()} />
            <StatCard label="Lander variants" value={landers.length.toLocaleString()} />
            <StatCard label="Min sessions" value={data.min_sessions.toLocaleString()} />
          </div>

          {/* ── Ad creative scorecard ── */}
          <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">Ad creatives</h2>
              <span className="text-[11px] text-zinc-400">
                Grouped by <code>utm_campaign</code> (= ad creative). ✦ = published via ShopCX.
                {hiddenAds > 0 && ` · ${hiddenAds} below min hidden`}
              </span>
            </div>
            {sortedAds.length === 0 ? (
              <p className="text-xs text-zinc-400">No ad traffic meets the minimum in this range.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
                      <th className="py-2 pr-2">Ad creative</th>
                      <SortableTh label="Sessions" k="sessions" sort={adSort} setSort={setAdSort} />
                      <SortableTh label="Engaged" k="engaged_rate_pct" sort={adSort} setSort={setAdSort} />
                      <SortableTh label="ATC" k="atc_rate_pct" sort={adSort} setSort={setAdSort} />
                      <SortableTh label="Leads" k="lead_rate_pct" sort={adSort} setSort={setAdSort} />
                      <SortableTh label="Orders" k="cvr_pct" sort={adSort} setSort={setAdSort} />
                      <SortableTh label="Revenue" k="revenue_cents" sort={adSort} setSort={setAdSort} />
                      <SortableTh label="Quality" k="quality_score" sort={adSort} setSort={setAdSort} />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedAds.map((a) => (
                      <tr key={a.campaign} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                        <td className="py-2 pr-2">
                          <div className="flex items-center gap-1.5">
                            {a.known_creative && <span title="Published via ShopCX ad tool" className="text-emerald-500">✦</span>}
                            <span className="max-w-[320px] truncate font-medium text-zinc-900 dark:text-zinc-100" title={a.campaign}>{a.campaign}</span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-400">
                            {a.meta_ad_id && <span className="font-mono">ad {a.meta_ad_id}</span>}
                            {a.sources.length > 0 && <span>· {a.sources.join(", ")}</span>}
                          </div>
                        </td>
                        <NumCell value={a.sessions.toLocaleString()} bold />
                        <RateCell n={a.engaged} pct={a.engaged_rate_pct} />
                        <RateCell n={a.add_to_cart} pct={a.atc_rate_pct} good={a.atc_rate_pct >= 5} />
                        <RateCell n={a.leads} pct={a.lead_rate_pct} />
                        <RateCell n={a.purchases} pct={a.cvr_pct} good={a.cvr_pct >= 2} />
                        <NumCell value={money(a.revenue_cents)} />
                        <td className="py-2 pr-2 text-right tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">{a.quality_score.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── Lander scorecard ── */}
          <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">Lander variants</h2>
              <span className="text-[11px] text-zinc-400">
                Grouped by <code>variant</code>/<code>angle</code> from the landing URL. Purchases session-scoped.
                {hiddenLanders > 0 && ` · ${hiddenLanders} below min hidden`}
              </span>
            </div>
            {landers.length === 0 ? (
              <p className="text-xs text-zinc-400">No lander traffic meets the minimum in this range.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
                      <th className="py-2 pr-2">Lander variant</th>
                      <th className="py-2 pr-2 text-right">Sessions</th>
                      <th className="py-2 pr-2 text-right">Engaged</th>
                      <th className="py-2 pr-2 text-right">ATC</th>
                      <th className="py-2 pr-2 text-right">Leads</th>
                      <th className="py-2 pr-2 text-right">Orders</th>
                      <th className="py-2 pr-2 text-right">Revenue</th>
                      <th className="py-2 pr-2 text-right">Quality</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...landers].sort((a, b) => b.sessions - a.sessions).map((l) => (
                      <tr key={`${l.variant}::${l.angle ?? ""}`} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                        <td className="py-2 pr-2">
                          <span className="font-medium capitalize text-zinc-900 dark:text-zinc-100">{l.variant}</span>
                          <div className="mt-0.5 flex flex-col text-[10px] text-zinc-400">
                            {l.headline && <span className="max-w-[320px] truncate italic" title={l.headline}>{l.headline}</span>}
                            {l.angle && <span className="font-mono">{l.angle}{l.publication ? ` · ${l.publication}` : ""}</span>}
                            {l.path && !l.angle && <span className="font-mono">{l.path}</span>}
                          </div>
                        </td>
                        <NumCell value={l.sessions.toLocaleString()} bold />
                        <RateCell n={l.engaged} pct={l.engaged_rate_pct} />
                        <RateCell n={l.add_to_cart} pct={l.atc_rate_pct} good={l.atc_rate_pct >= 5} />
                        <RateCell n={l.leads} pct={l.lead_rate_pct} />
                        <RateCell n={l.purchases} pct={l.cvr_pct} good={l.cvr_pct >= 2} />
                        <NumCell value={money(l.revenue_cents)} />
                        <td className="py-2 pr-2 text-right tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">{l.quality_score.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="text-[11px] leading-relaxed text-zinc-400">
            <strong>Quality score</strong> weights bottom-of-funnel rates: CVR×6 + ATC×2 + lead×1.5 + engaged×0.4.
            Engagement, ATC and leads are measured per-session on the session&apos;s own creative/lander. Ad-creative
            purchases use first-touch order attribution (so coupon-return / cross-session sales still count); lander
            purchases are session-scoped because orders don&apos;t store the lander variant.
          </p>
        </>
      )}
    </div>
  );
}

function SortableTh({ label, k, sort, setSort }: { label: string; k: AdSortKey; sort: AdSortKey; setSort: (k: AdSortKey) => void }) {
  const active = sort === k;
  return (
    <th className="py-2 pr-2 text-right">
      <button
        onClick={() => setSort(k)}
        className={`inline-flex items-center gap-0.5 uppercase tracking-wider ${active ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}
      >
        {label}{active && <span aria-hidden>↓</span>}
      </button>
    </th>
  );
}

function NumCell({ value, bold }: { value: string; bold?: boolean }) {
  return (
    <td className={`py-2 pr-2 text-right tabular-nums ${bold ? "font-semibold text-zinc-900 dark:text-zinc-100" : "text-zinc-700 dark:text-zinc-300"}`}>
      {value}
    </td>
  );
}

function RateCell({ n, pct, good }: { n: number; pct: number; good?: boolean }) {
  return (
    <td className="py-2 pr-2 text-right tabular-nums">
      <span className={`font-semibold ${good ? "text-emerald-600" : "text-zinc-900 dark:text-zinc-100"}`}>{pct.toFixed(1)}%</span>
      <span className="ml-1 text-[10px] text-zinc-400">{n.toLocaleString()}</span>
    </td>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</p>
    </div>
  );
}

function MinVolumePicker({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
      Min sessions
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
      >
        {[1, 5, 10, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  );
}

function DateRangePicker({
  preset, setPreset, start, end, setStart, setEnd,
}: {
  preset: Preset; setPreset: (p: Preset) => void;
  start: string; end: string; setStart: (s: string) => void; setEnd: (s: string) => void;
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
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)}
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
          <span className="text-xs text-zinc-500">to</span>
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)}
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
      )}
    </div>
  );
}
