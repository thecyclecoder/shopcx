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

import { useEffect, useState, useCallback, Fragment } from "react";
import { useWorkspace } from "@/lib/workspace-context";

// ── Rebuilt funnel: hierarchical product → PDP / All Landers → variant → angle.
// Powered by libraries/funnel-tree (the SDK) and the page-level product slice.
// As each legacy card is reworked onto the SDK + slice it gets the two pills
// below, so reworked cards are visually distinguishable from the old ones.
interface TreeMetrics {
  visit: number; engaged: number; pack_selected: number; checkout_started: number;
  order_placed: number; add_to_cart: number; sub_orders: number;
  engagement_rate: number; pack_rate: number; checkout_rate: number; conversion_rate: number;
  atc_rate: number; sub_attach_rate: number; aov_cents: number;
  revenue_cents: number; ltv_cents: number;
  revenue_per_visit_cents: number; ltv_per_visit_cents: number;
}
interface TreeNode {
  level: "product" | "pdp" | "all_landers" | "variant" | "angle";
  key: string; label: string; metrics: TreeMetrics; children?: TreeNode[];
  enrichment?: { headline?: string | null; hero_kind?: string | null; product_title?: string | null; product_handle?: string | null };
}
interface FunnelTreeResponse {
  range: { start: string; end: string };
  productHandle: string | null;
  utmSource: string | null;
  referrer: string | null;
  products: TreeNode[];
  unattributedEntry: TreeNode | null;
  grandTotal: TreeMetrics;
  ltvBasis: { monthly_churn: number; sub_lifetime_orders: number; months_used: number; window: string };
  productOptions: Array<{ handle: string; title: string; sessions: number }>;
  utmSourceOptions: Array<{ source: string; label: string; sessions: number }>;
  referrerOptions: Array<{ referrer: string; label: string; sessions: number }>;
  breakdowns: { device: BreakdownRowT[]; country: BreakdownRowT[]; language: BreakdownRowT[] };
}
interface BreakdownRowT { value: string; visits: number; orders: number; cvr: number; ltv_per_visit_cents: number; }

interface PopupVariantRow { variant: string; label: string; shown: number; engaged: number; email: number; phone: number }
interface CartAnalyticsResponse {
  range: { start: string; end: string };
  abandoned: { open_with_email: number; carts_reminded: number; followups_sent: number; recovered: number; recovery_rate_pct: number; revenue_recovered_cents: number; misfired_reminders: number; fast_converted_in_session: number };
  leads: { emails: number; phones: number };
  popupFunnel: { byVariant: PopupVariantRow[]; totals: { shown: number; engaged: number; email: number; phone: number } };
  surveyFunnel: { shown: number; steps: Array<{ step: string; label: string; reached: number; pct_of_shown: number }>; completed: number; email: number; answers: { cups_per_day: Array<{ value: string; count: number }>; health_goal: Array<{ value: string; count: number }>; coffee_style: Array<{ value: string; count: number }> } };
  packBreakdown: { rows: Array<{ label: string; count: number; pct: number }> };
}

/** SDK-driven, slice + destination aware pack-size breakdown (AOV / decoy lens). */
function PackBreakdownCard({ data, loading, dest, onDest, destOptions }: {
  data: CartAnalyticsResponse | null; loading: boolean; dest: string; onDest: (v: string) => void;
  destOptions: Array<{ key: string; label: string; level: "pdp" | "variant" | "angle"; visits: number }>;
}) {
  const rows = data?.packBreakdown?.rows ?? [];
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">Pack size chosen</h2>
          <p className="mt-1 text-xs text-zinc-400">The mix behind AOV — reorder the price table / tune the decoy to shift it.</p>
        </div>
        <ReworkedPills />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Destination</span>
        <select value={dest} onChange={(e) => onDest(e.target.value)} className={selectClass}>
          <option value="">All destinations</option>
          {destOptions.map((d) => (<option key={d.key} value={d.key}>{d.level === "angle" ? "— " : ""}{d.label}</option>))}
        </select>
      </div>
      {loading && !data && <p className="text-sm text-zinc-400">Loading…</p>}
      {data && rows.length === 0 && <p className="text-xs text-zinc-400">No pack selections in this range.</p>}
      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center gap-3">
              <span className="w-28 shrink-0 text-sm text-zinc-700 dark:text-zinc-300">{r.label}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${(r.count / max) * 100}%` }} /></div>
              <span className="w-20 shrink-0 text-right text-sm tabular-nums"><strong className="text-zinc-900 dark:text-zinc-100">{r.count}</strong> <span className="text-zinc-400">{r.pct.toFixed(0)}%</span></span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** SDK-driven survey-chapter funnel + answer distributions, slice + destination
 *  aware. (Survey events were dropped by the pixel allowlist — fixed 2026-06-30.) */
function SurveyFunnelCard({ data, loading, dest, onDest, destOptions }: {
  data: CartAnalyticsResponse | null; loading: boolean; dest: string; onDest: (v: string) => void;
  destOptions: Array<{ key: string; label: string; level: "pdp" | "variant" | "angle"; visits: number }>;
}) {
  const sf = data?.surveyFunnel;
  const AnswerBlock = ({ title, rows }: { title: string; rows: Array<{ value: string; count: number }> }) => {
    const max = Math.max(...rows.map((r) => r.count), 1);
    return (
      <div>
        <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-400">{title}</p>
        {rows.length === 0 ? <p className="text-xs text-zinc-400">—</p> : rows.map((r) => (
          <div key={r.value} className="mb-1 flex items-center gap-2 text-xs">
            <span className="w-28 shrink-0 truncate text-zinc-700 dark:text-zinc-300">{r.value}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800"><div className="h-full bg-zinc-900 dark:bg-zinc-100" style={{ width: `${(r.count / max) * 100}%` }} /></div>
            <span className="w-8 shrink-0 text-right tabular-nums text-zinc-900 dark:text-zinc-100">{r.count}</span>
          </div>
        ))}
      </div>
    );
  };
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">Survey chapter</h2>
        <ReworkedPills />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Destination</span>
        <select value={dest} onChange={(e) => onDest(e.target.value)} className={selectClass}>
          <option value="">All destinations</option>
          {destOptions.map((d) => (<option key={d.key} value={d.key}>{d.level === "angle" ? "— " : ""}{d.label}</option>))}
        </select>
      </div>
      {loading && !data && <p className="text-sm text-zinc-400">Loading…</p>}
      {sf && sf.shown === 0 && <p className="text-xs text-zinc-400">No survey impressions yet — survey event tracking was just enabled, so this will populate with new traffic.</p>}
      {sf && sf.shown > 0 && (
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <div className="mb-2 grid grid-cols-2 gap-2">
              <StatCard label="Shown" value={sf.shown.toLocaleString()} />
              <StatCard label="Completed" value={`${sf.completed} (${sf.shown > 0 ? ((sf.completed / sf.shown) * 100).toFixed(0) : 0}%)`} tone={sf.completed > 0 ? "good" : "neutral"} />
            </div>
            {sf.steps.map((s) => (
              <div key={s.step} className="mb-1 flex items-center gap-2 text-xs">
                <span className="w-24 shrink-0 text-zinc-600 dark:text-zinc-400">{s.label}</span>
                <div className="h-2 flex-1 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800"><div className="h-full bg-emerald-500" style={{ width: `${s.pct_of_shown}%` }} /></div>
                <span className="w-16 shrink-0 text-right tabular-nums text-zinc-900 dark:text-zinc-100">{s.reached} · {s.pct_of_shown.toFixed(0)}%</span>
              </div>
            ))}
          </div>
          <div className="space-y-3">
            <AnswerBlock title="Cups per day (Q1)" rows={sf.answers.cups_per_day} />
            <AnswerBlock title="Health goal (Q2)" rows={sf.answers.health_goal} />
            <AnswerBlock title="Coffee style (Q3)" rows={sf.answers.coffee_style} />
          </div>
        </div>
      )}
    </section>
  );
}

/** SDK-driven, slice + destination aware lead-capture popup funnel. */
function PopupFunnelCard({ data, loading, dest, onDest, destOptions }: {
  data: CartAnalyticsResponse | null; loading: boolean; dest: string; onDest: (v: string) => void;
  destOptions: Array<{ key: string; label: string; level: "pdp" | "variant" | "angle"; visits: number }>;
}) {
  const pf = data?.popupFunnel;
  const rows = pf ? [...pf.byVariant, { variant: "total", label: "Total", ...pf.totals }] : [];
  const rate = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—");
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">Lead-capture popup</h2>
        <ReworkedPills />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Destination</span>
        <select value={dest} onChange={(e) => onDest(e.target.value)} className={selectClass}>
          <option value="">All destinations</option>
          {destOptions.map((d) => (<option key={d.key} value={d.key}>{d.level === "angle" ? "— " : ""}{d.label}</option>))}
        </select>
        <span className="text-xs text-zinc-400">Re-scopes this card only.</span>
      </div>
      {loading && !data && <p className="text-sm text-zinc-400">Loading…</p>}
      {pf && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-[10px] uppercase tracking-wide text-zinc-400 dark:border-zinc-800">
                <th className="py-2 text-left font-medium">Variant</th>
                <th className="py-2 text-right font-medium">Shown</th>
                <th className="py-2 text-right font-medium">Engaged</th>
                <th className="py-2 text-right font-medium">Email (step 1)</th>
                <th className="py-2 text-right font-medium">Phone (step 2)</th>
                <th className="py-2 text-right font-medium">Email→Phone</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.variant} className={"border-b border-zinc-100 last:border-0 dark:border-zinc-800/50 " + (r.variant === "total" ? "font-semibold" : "")}>
                  <td className="py-1.5 text-zinc-700 dark:text-zinc-300">{r.label === "Offer" ? "Offer (discount)" : r.label === "Survey" ? "Survey (quiz)" : r.label}</td>
                  <td className="py-1.5 text-right tabular-nums text-zinc-900 dark:text-zinc-100">{r.shown.toLocaleString()}</td>
                  <td className="py-1.5 text-right tabular-nums">{r.engaged.toLocaleString()} <span className="text-[10px] text-zinc-400">{rate(r.engaged, r.shown)}</span></td>
                  <td className="py-1.5 text-right tabular-nums">{r.email.toLocaleString()} <span className="text-[10px] text-zinc-400">{rate(r.email, r.shown)}</span></td>
                  <td className="py-1.5 text-right tabular-nums">{r.phone.toLocaleString()} <span className="text-[10px] text-zinc-400">{rate(r.phone, r.shown)}</span></td>
                  <td className="py-1.5 text-right tabular-nums font-medium text-emerald-600 dark:text-emerald-400">{rate(r.phone, r.email)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Abandoned-cart + lead capture SUMMARY (no per-cart logs), slice + destination
 *  aware. Recovery is corrected (credits returns-via-new-cart) + flags mis-fires. */
function CartAnalyticsCard({ data, loading, dest, onDest, destOptions }: {
  data: CartAnalyticsResponse | null; loading: boolean; dest: string; onDest: (v: string) => void;
  destOptions: Array<{ key: string; label: string; level: "pdp" | "variant" | "angle"; visits: number }>;
}) {
  const a = data?.abandoned;
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">Abandoned carts &amp; lead capture</h2>
          <p className="mt-1 text-xs text-zinc-400">Reminder is a 2-step sequence (step 1 + follow-up). Recovery credits a reminded customer who orders afterward, even via a new cart.</p>
        </div>
        <ReworkedPills />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Destination</span>
        <select value={dest} onChange={(e) => onDest(e.target.value)} className={selectClass}>
          <option value="">All destinations</option>
          {destOptions.map((d) => (<option key={d.key} value={d.key}>{d.level === "angle" ? "— " : ""}{d.label}</option>))}
        </select>
        <span className="text-xs text-zinc-400">Re-scopes this card only.</span>
      </div>

      {loading && !data && <p className="text-sm text-zinc-400">Loading…</p>}

      {a && data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Open (has email)" value={a.open_with_email.toLocaleString()} />
          <StatCard label="Carts reminded (×2 steps)" value={`${a.carts_reminded} / ${a.followups_sent}`} />
          <StatCard label="Recovered" value={a.recovered.toLocaleString()} tone={a.recovered > 0 ? "good" : "neutral"} />
          <StatCard label="Recovery rate" value={`${a.recovery_rate_pct.toFixed(1)}%`} tone={a.recovery_rate_pct >= 10 ? "good" : "neutral"} />
          <StatCard label="Revenue recovered" value={money(a.revenue_recovered_cents)} tone={a.revenue_recovered_cents > 0 ? "good" : "neutral"} />
          <StatCard label="Fast in-session buys" value={a.fast_converted_in_session.toLocaleString()} />
          <StatCard label="Mis-fired reminders" value={a.misfired_reminders.toLocaleString()} tone={a.misfired_reminders > 0 ? "bad" : "neutral"} />
          <StatCard label="Leads (email / phone)" value={`${data.leads.emails} / ${data.leads.phones}`} />
        </div>
      )}
    </section>
  );
}

/** SDK-driven, slice-aware dimension breakdown with CVR + LTV/visit per row —
 *  surfaces a high-traffic segment that doesn't convert (tablet layout bug,
 *  PR shipping friction, …). */
function BreakdownPanel({ title, rows }: { title: string; rows: BreakdownRowT[] }) {
  const max = Math.max(...rows.map((r) => r.visits), 1);
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
        <ReworkedPills />
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-zinc-400">
            <th className="pb-1 text-left font-medium">{title}</th>
            <th className="pb-1 text-right font-medium">Sessions</th>
            <th className="pb-1 text-right font-medium">CVR</th>
            <th className="pb-1 text-right font-medium">LTV/visit</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={4} className="py-2 text-xs text-zinc-400">No sessions.</td></tr>}
          {rows.map((r) => (
            <tr key={r.value} className="border-t border-zinc-100 dark:border-zinc-800/50">
              <td className="py-1.5 pr-2 text-zinc-700 dark:text-zinc-300">{r.value}</td>
              <td className="py-1.5 text-right">
                <div className="flex items-center justify-end gap-2">
                  <div className="hidden h-1.5 w-16 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800 sm:block">
                    <div className="h-full bg-zinc-900 dark:bg-zinc-100" style={{ width: `${(r.visits / max) * 100}%` }} />
                  </div>
                  <span className="tabular-nums text-zinc-900 dark:text-zinc-100">{r.visits.toLocaleString()}</span>
                </div>
              </td>
              <td className={"py-1.5 text-right tabular-nums " + (r.cvr > 0 ? "font-medium text-emerald-600 dark:text-emerald-400" : "text-zinc-400")}>{r.cvr.toFixed(1)}%</td>
              <td className="py-1.5 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{money(r.ltv_per_visit_cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The badge pair marking a card as rebuilt onto the SDK + slice. */
function ReworkedPills() {
  return (
    <div className="flex items-center gap-1.5">
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
        ⚡ SDK-powered
      </span>
      <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300">
        ◫ Slice-aware
      </span>
    </div>
  );
}

const selectClass =
  "rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100";

/** Page-level universal slices (product × traffic source). They compose, and
 *  drive every reworked card below. */
function SliceFilter({ productOptions, product, onProduct, utmOptions, utmSource, onUtmSource, referrerOptions, referrer, onReferrer }: {
  productOptions: Array<{ handle: string; title: string; sessions: number }>;
  product: string; onProduct: (v: string) => void;
  utmOptions: Array<{ source: string; label: string; sessions: number }>;
  utmSource: string; onUtmSource: (v: string) => void;
  referrerOptions: Array<{ referrer: string; label: string; sessions: number }>;
  referrer: string; onReferrer: (v: string) => void;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Product</span>
        <select value={product} onChange={(e) => onProduct(e.target.value)} className={selectClass}>
          <option value="">All products</option>
          {product && !productOptions.some((o) => o.handle === product) && <option value={product}>{product} (0)</option>}
          {productOptions.map((o) => (
            <option key={o.handle} value={o.handle}>{o.title} ({o.sessions.toLocaleString()})</option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Source</span>
        <select value={utmSource} onChange={(e) => onUtmSource(e.target.value)} className={selectClass}>
          <option value="">All sources</option>
          {utmSource && !utmOptions.some((o) => o.source === utmSource) && <option value={utmSource}>{utmSource} (0)</option>}
          {utmOptions.map((o) => (
            <option key={o.source} value={o.source}>{o.label} ({o.sessions.toLocaleString()})</option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Referrer</span>
        <select value={referrer} onChange={(e) => onReferrer(e.target.value)} className={selectClass}>
          <option value="">All referrers</option>
          {referrer && !referrerOptions.some((o) => o.referrer === referrer) && <option value={referrer}>{referrer} (0)</option>}
          {referrerOptions.map((o) => (
            <option key={o.referrer} value={o.referrer}>{o.label} ({o.sessions.toLocaleString()})</option>
          ))}
        </select>
      </div>
      <span className="text-xs text-zinc-400">Slices compose. Drive every reworked card below.</span>
    </div>
  );
}

function flattenTree(nodes: TreeNode[], expanded: Set<string>, depth = 0, parent = ""): Array<{ node: TreeNode; depth: number; path: string; hasChildren: boolean; isOpen: boolean }> {
  const rows: Array<{ node: TreeNode; depth: number; path: string; hasChildren: boolean; isOpen: boolean }> = [];
  for (const n of nodes) {
    const path = parent ? `${parent}/${n.key}` : n.key;
    const hasChildren = !!(n.children && n.children.length);
    const isOpen = expanded.has(path);
    rows.push({ node: n, depth, path, hasChildren, isOpen });
    if (hasChildren && isOpen) rows.push(...flattenTree(n.children!, expanded, depth + 1, path));
  }
  return rows;
}
function pctStr(x: number) { return (x * 100).toFixed(1) + "%"; }
function money(cents: number) { return "$" + (cents / 100).toFixed(2); }

/** A funnel-step cell: the count with its rate-from-visit beneath, so each
 *  step's % is visible for period-over-period drift comparison. */
function StepCell({ count, rate, strong, rateGood }: { count: number; rate: number; strong?: boolean; rateGood?: boolean }) {
  return (
    <td className="py-1.5 text-right">
      <div className={"tabular-nums " + (strong ? "font-medium text-zinc-900 dark:text-zinc-100" : "text-zinc-700 dark:text-zinc-300")}>{count.toLocaleString()}</div>
      <div className={"text-[10px] tabular-nums " + (rateGood && rate > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-400")}>{pctStr(rate)}</div>
    </td>
  );
}

// ── Chapter diagnostics (the "why") — per-destination chapter sequence ──────
interface ChapterDiagRow {
  chapter: string; label: string; index: number | null;
  reach: number; reach_pct: number; avg_dwell_ms: number;
  cta_origin: number; cta_origin_pct: number;
  view_to_pricing_pct: number; view_to_pack_pct: number;
}
interface FunnelStepDatum { step: string; label: string; count: number; conv_from_prev_pct: number; conv_from_top_pct: number; drop_from_prev: number; }
interface ChapterDiagResponse {
  range: { start: string; end: string };
  destination: { key: string; label: string } | null;
  availableDestinations: Array<{ key: string; label: string; level: "pdp" | "variant" | "angle"; visits: number; parent?: string }>;
  summary: { visits: number; reached_pricing: number; carry_to_pricing_pct: number; packed: number; close_pct: number; jumped_to_pricing: number; scrolled_to_pricing: number } | null;
  funnelSteps: FunnelStepDatum[];
  chapters: ChapterDiagRow[];
  bottlenecks?: { destinations: Array<{ key: string; label: string; bottleneck: string; recommendation: string; confidence: string }> };
}

/** SDK-driven, slice-aware funnel waterfall (vertical bars) with a card-local
 *  destination selector — the same controls as the chapter-diagnostics card. */
function FunnelWaterfallCard({ data, loading, dest, onDest }: {
  data: ChapterDiagResponse | null; loading: boolean; dest: string; onDest: (v: string) => void;
}) {
  const steps = data?.funnelSteps ?? [];
  const top = steps[0]?.count || 1;
  const effectiveDest = dest || data?.destination?.key || "";
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">Funnel</h2>
        <ReworkedPills />
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Destination</span>
        <select value={effectiveDest} onChange={(e) => onDest(e.target.value)} className={selectClass}>
          {(data?.availableDestinations ?? []).map((d) => (
            <option key={d.key} value={d.key}>{d.level === "angle" ? "— " : ""}{d.label} ({d.visits.toLocaleString()})</option>
          ))}
        </select>
        <span className="text-xs text-zinc-400">Re-scopes this card only.</span>
      </div>

      {loading && !data && <p className="text-sm text-zinc-400">Loading…</p>}

      {steps.length > 0 && (
        <div className="flex items-end gap-3 sm:gap-5" style={{ height: 200 }}>
          {steps.map((s, i) => {
            const h = Math.max(2, Math.round((s.count / top) * 100));
            const isLast = i === steps.length - 1;
            return (
              <div key={s.step} className="flex h-full flex-1 flex-col items-center justify-end text-center">
                <div className="mb-1 text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{s.count.toLocaleString()}</div>
                <div className={"w-full rounded-t " + (isLast ? "bg-emerald-500" : "bg-zinc-800 dark:bg-zinc-200")} style={{ height: `${h}%` }} />
                <div className="mt-2 text-[11px] font-medium leading-tight text-zinc-600 dark:text-zinc-300">{s.label}</div>
                <div className="text-[10px] tabular-nums text-zinc-400">
                  {i === 0 ? "top" : `${s.conv_from_prev_pct.toFixed(0)}% prev`}
                  {i > 0 && s.drop_from_prev > 0 && <span className="ml-1 text-rose-400">↓{s.drop_from_prev}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function dwellStr(ms: number) { return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`; }

/** The "why" card: a destination's chapter sequence — where it leaks (reach by
 *  placement), which chapter earns the pricing click (CTA-origin), dwell, and
 *  the carry/close levers. Card-local destination selector (this card only). */
function ChapterDiagnosticsCard({ data, loading, dest, onDest }: {
  data: ChapterDiagResponse | null; loading: boolean; dest: string; onDest: (v: string) => void;
}) {
  const effectiveDest = dest || data?.destination?.key || "";
  const s = data?.summary;
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">Chapter diagnostics — the &ldquo;why&rdquo;</h2>
          <p className="mt-1 text-xs text-zinc-400">Where the sequence leaks (reach by placement), which chapter earns the pricing click, and the two levers: carry-to-pricing &amp; close.</p>
        </div>
        <ReworkedPills />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Destination</span>
        <select value={effectiveDest} onChange={(e) => onDest(e.target.value)} className={selectClass}>
          {(data?.availableDestinations ?? []).map((d) => (
            <option key={d.key} value={d.key}>{d.level === "angle" ? "— " : ""}{d.label} ({d.visits.toLocaleString()})</option>
          ))}
        </select>
        <span className="text-xs text-zinc-400">Re-scopes this card only.</span>
      </div>

      {loading && !data && <p className="text-sm text-zinc-400">Loading…</p>}

      {s && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Visits" value={s.visits.toLocaleString()} />
          <StatCard label="Carry → pricing" value={`${s.carry_to_pricing_pct.toFixed(1)}%`} tone={s.carry_to_pricing_pct >= 25 ? "good" : "neutral"} />
          <StatCard label="Close (pricing→pack)" value={`${s.close_pct.toFixed(1)}%`} tone={s.close_pct >= 12 ? "good" : "neutral"} />
          <StatCard label="Jump / scroll to price" value={`${s.jumped_to_pricing} / ${s.scrolled_to_pricing}`} />
        </div>
      )}

      {(() => {
        const v = data?.bottlenecks?.destinations?.find((d) => d.key === data?.destination?.key);
        if (!v || v.bottleneck === "insufficient_data") return null;
        const tone = v.bottleneck === "close" ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
          : v.bottleneck === "carry" ? "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300"
          : "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300";
        return (
          <div className={`mb-4 rounded-md border px-3 py-2 text-xs ${tone}`}>
            <strong className="uppercase tracking-wide">Bottleneck: {v.bottleneck}</strong> — {v.recommendation}
            <span className="ml-1 opacity-60">(confidence: {v.confidence})</span>
          </div>
        );
      })()}

      {data && data.chapters.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
                <th className="py-2 pr-2">#</th>
                <th className="py-2 pr-2">Chapter (page order)</th>
                <th className="py-2 pr-2 text-right">Reach %</th>
                <th className="py-2 pr-2 text-right">Avg dwell</th>
                <th className="py-2 pr-2 text-right">CTA→price origin</th>
                <th className="py-2 pr-2 text-right">View→pack %</th>
              </tr>
            </thead>
            <tbody>
              {data.chapters.map((c) => (
                <tr key={c.chapter} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                  <td className="py-2 pr-2 tabular-nums text-zinc-400">{c.index ?? "·"}</td>
                  <td className="py-2 pr-2 text-zinc-900 dark:text-zinc-100">{c.label}</td>
                  <td className="py-2 pr-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{c.reach_pct.toFixed(1)}%</td>
                  <td className="py-2 pr-2 text-right tabular-nums text-zinc-500">{dwellStr(c.avg_dwell_ms)}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    <span className={c.cta_origin_pct >= 15 ? "font-semibold text-emerald-600 dark:text-emerald-400" : c.cta_origin_pct > 0 ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-400"}>
                      {c.cta_origin_pct.toFixed(1)}%
                    </span>
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums font-medium text-zinc-900 dark:text-zinc-100">{c.view_to_pack_pct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The first reworked card: the product → PDP/landers → variant → angle tree. */
function FunnelTreeCard({ tree, loading }: { tree: FunnelTreeResponse | null; loading: boolean }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!tree) return;
    const open = new Set<string>();
    const walk = (nodes: TreeNode[], parent = "") => {
      for (const n of nodes) {
        const path = parent ? `${parent}/${n.key}` : n.key;
        if (n.level === "product" || n.level === "all_landers") open.add(path);
        if (n.children) walk(n.children, path);
      }
    };
    walk(tree.products);
    setExpanded(open);
  }, [tree]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });

  const allNodes: TreeNode[] = tree
    ? [...tree.products, ...(tree.unattributedEntry ? [tree.unattributedEntry] : [])]
    : [];
  const rows = flattenTree(allNodes, expanded);

  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">Funnel by product &amp; concept</h2>
          {tree && (
            <p className="mt-1 text-xs text-zinc-400">
              Bare PDP vs targeted landers, rolled up per product. {tree.grandTotal.visit.toLocaleString()} visits · {pctStr(tree.grandTotal.conversion_rate)} CVR · <strong className="text-zinc-500 dark:text-zinc-300">{money(tree.grandTotal.ltv_per_visit_cents)} LTV/visit</strong> · {tree.range.start} → {tree.range.end}
              <span className="ml-1 text-zinc-400">· LTV: subs ×{tree.ltvBasis.sub_lifetime_orders.toFixed(1)} ({(tree.ltvBasis.monthly_churn * 100).toFixed(1)}% churn, {tree.ltvBasis.window})</span>
            </p>
          )}
        </div>
        <ReworkedPills />
      </div>

      {loading && !tree && <p className="text-sm text-zinc-400">Loading…</p>}

      {tree && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-400 dark:border-zinc-800">
                <th className="py-2 text-left font-medium">Concept</th>
                <th className="py-2 text-right font-medium">Visits</th>
                <th className="py-2 text-right font-medium">Engaged</th>
                <th className="py-2 text-right font-medium">Pack</th>
                <th className="py-2 text-right font-medium">Checkout</th>
                <th className="py-2 text-right font-medium">Orders</th>
                <th className="py-2 text-right font-medium">Sub-attach</th>
                <th className="py-2 text-right font-medium">AOV</th>
                <th className="py-2 text-right font-medium">Rev/visit</th>
                <th className="py-2 text-right font-medium">LTV/visit</th>
              </tr>
              <tr className="text-[9px] uppercase tracking-wide text-zinc-300 dark:text-zinc-600">
                <th /><th /><th className="text-right font-normal">n · rate</th><th className="text-right font-normal">n · rate</th><th className="text-right font-normal">n · rate</th><th className="text-right font-normal">n · CVR</th><th /><th /><th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={10} className="py-3 text-sm text-zinc-400">No sessions in this window.</td></tr>
              )}
              {rows.map(({ node, depth, path, hasChildren, isOpen }) => {
                const m = node.metrics;
                return (
                  <tr key={path} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                    <td className="py-1.5">
                      <div className="flex items-center" style={{ paddingLeft: depth * 18 }}>
                        {hasChildren ? (
                          <button onClick={() => toggle(path)} className="mr-1 w-4 shrink-0 text-zinc-400 hover:text-zinc-600">
                            {isOpen ? "▾" : "▸"}
                          </button>
                        ) : (
                          <span className="mr-1 inline-block w-4 shrink-0" />
                        )}
                        <span className={
                          node.level === "product" ? "font-semibold text-zinc-900 dark:text-zinc-100"
                          : node.level === "all_landers" ? "font-medium text-sky-700 dark:text-sky-300"
                          : node.level === "pdp" ? "font-medium text-zinc-700 dark:text-zinc-300"
                          : node.level === "variant" ? "text-zinc-700 dark:text-zinc-300"
                          : "text-zinc-500 dark:text-zinc-400"
                        }>
                          {node.label}
                        </span>
                      </div>
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-900 dark:text-zinc-100">{m.visit.toLocaleString()}</td>
                    <StepCell count={m.engaged} rate={m.engagement_rate} />
                    <StepCell count={m.pack_selected} rate={m.pack_rate} />
                    <StepCell count={m.checkout_started} rate={m.checkout_rate} />
                    <StepCell count={m.order_placed} rate={m.conversion_rate} strong rateGood />
                    <td className="py-1.5 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{m.order_placed > 0 ? pctStr(m.sub_attach_rate) : "—"}</td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{m.order_placed > 0 ? money(m.aov_cents) : "—"}</td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{money(m.revenue_per_visit_cents)}</td>
                    <td className={"py-1.5 text-right tabular-nums font-semibold " + (m.ltv_per_visit_cents > 0 ? "text-emerald-700 dark:text-emerald-300" : "text-zinc-400")}>{money(m.ltv_per_visit_cents)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface FunnelStepRow {
  step: string;
  sessions: number;
  conv_from_prev_pct: number;
  conv_from_top_pct: number;
  drop_from_prev: number;
}

interface AbandonedCartsBlock {
  emailed: number;
  recovered: number;
  revenue_recovered_cents: number;
  open_with_email: number;
  recovery_rate_pct: number;
  recent: Array<{
    id: string;
    email: string;
    item_count: number;
    subtotal_cents: number;
    status: string;
    abandoned_email_sent_at: string | null;
    converted_order_id: string | null;
    created_at: string;
  }>;
}

interface FunnelData {
  range: { start: string; end: string };
  total_sessions: number;
  add_to_cart: number;
  leads_generated: number;
  popupFunnel?: {
    byVariant: Array<{ variant: string; label: string; shown: number; engaged: number; email: number; phone: number }>;
    totals: { shown: number; engaged: number; email: number; phone: number };
  };
  surveyFunnel?: { shown: number; completed: number; email: number; phone: number };
  funnel: FunnelStepRow[];
  topProducts: Array<{ product_id: string; title: string; handle: string | null; pack_selected_count: number }>;
  packBreakdown?: Array<{ label: string; count: number }>;
  deviceBreakdown: Array<{ device_type: string; sessions: number }>;
  countryBreakdown: Array<{ ip_country: string; sessions: number }>;
  sourceBreakdown: Array<{ utm_source: string; sessions: number }>;
  chapterPerformance?: Array<{
    chapter: string;
    chapter_index: number;
    reach_sessions: number;
    reach_rate_pct: number;
    avg_dwell_ms: number;
    scroll_to_price_sessions: number;
    view_to_cta_pct: number;
  }>;
  abandonedCarts?: AbandonedCartsBlock;
  runningExperiments?: Array<{
    experiment_id: string;
    product_id: string;
    lever: string;
    lander_type: string;
    status: string;
    holdout_pct: number;
    arms: Array<{
      variant_id: string;
      label: string;
      is_control: boolean;
      sessions: number;
      conversions: number;
      sub_attach: number;
      revenue_cents: number;
      win_prob: number | null;
    }>;
  }>;
  leverImportance?: Array<{
    lever_key: string;
    chapter: string;
    kind: "chapter" | "component";
    product_id: string;
    lander_type: string;
    audience: string;
    importance: number;
    prior: number;
    n_tests: number;
    scope: "product_specific" | "general";
    last_tested_at: string | null;
  }>;
  predictedLtv?: Array<{
    product_id: string;
    product_title: string;
    lander_type: string;
    audience: string;
    snapshot_date: string;
    visitors: number;
    sub_attach_rate: number;
    est_sub_ltv_cents: number;
    predicted_ltv_per_visitor_cents: number;
    prior_snapshot_date: string | null;
    prior_predicted_ltv_per_visitor_cents: number | null;
    wow_delta_pct: number | null;
    weights_version: number;
    calibrated: boolean;
    flags: Record<string, unknown>;
  }>;
  campaignGrades?: {
    graded: number;
    avg_grade: number | null;
    avg_hypothesis_quality: number | null;
    trend: Array<{ at: string; grade: number }>;
    proposed_rules: Array<{ id: string; title: string; content: string; created_at: string }>;
    rows: Array<{
      grade_id: string;
      experiment_id: string;
      product_id: string;
      product_title: string;
      lever: string;
      lander_type: string;
      audience: string;
      status: string;
      grade_initial: number | null;
      grade_revised: number | null;
      hypothesis_quality: number | null;
      result_quality: number | null;
      grade_initial_reasoning: string | null;
      grade_revised_reasoning: string | null;
      graded_by: string;
      overridden_by: string | null;
      initial_graded_at: string | null;
      revised_graded_at: string | null;
    }>;
  };
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

/**
 * Date presets resolved in Central time, matching the rest of the
 * analytics dashboards (ROAS, MRR). Avoids the "today's events miss
 * the bucket between midnight UTC and midnight CT" off-by-six-hours
 * footgun for late-night activity.
 */
function todayCentral(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function daysAgoCentral(n: number): string {
  // Use noon UTC on the n-days-ago anchor so the formatted Central
  // date is unambiguous (noon UTC = morning CT, comfortably away
  // from midnight in either direction).
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

const STEP_LABELS: Record<string, string> = {
  pdp_view: "PDP visit",
  pdp_engaged: "Engaged",
  pack_selected: "Pack selected",
  customize_view: "Customize page",
  checkout_view: "Checkout started",
  order_placed: "Order placed",
};

export default function StorefrontFunnelPage() {
  const workspace = useWorkspace();
  const [preset, setPreset] = useState<Preset>("7d");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [data, setData] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);
  // Page-level slices ("" = all) + the SDK-powered tree they drive.
  const [product, setProduct] = useState("");
  const [utmSource, setUtmSource] = useState("");
  const [referrer, setReferrer] = useState("");
  const [tree, setTree] = useState<FunnelTreeResponse | null>(null);
  const [treeLoading, setTreeLoading] = useState(true);
  // Card-local destination for the chapter "why" card (re-scopes that card only).
  const [chapterDest, setChapterDest] = useState("");
  const [chapter, setChapter] = useState<ChapterDiagResponse | null>(null);
  const [chapterLoading, setChapterLoading] = useState(true);
  // The rebuilt funnel waterfall — its own card-local destination (chapter-diagnostics endpoint).
  const [waterfallDest, setWaterfallDest] = useState("");
  const [waterfall, setWaterfall] = useState<ChapterDiagResponse | null>(null);
  const [waterfallLoading, setWaterfallLoading] = useState(true);
  const [cartDest, setCartDest] = useState("");
  const [cart, setCart] = useState<CartAnalyticsResponse | null>(null);
  const [cartLoading, setCartLoading] = useState(true);
  const [popupDest, setPopupDest] = useState("");
  const [popup, setPopup] = useState<CartAnalyticsResponse | null>(null);
  const [popupLoading, setPopupLoading] = useState(true);
  const [surveyDest, setSurveyDest] = useState("");
  const [survey, setSurvey] = useState<CartAnalyticsResponse | null>(null);
  const [surveyLoading, setSurveyLoading] = useState(true);
  const [packDest, setPackDest] = useState("");
  const [pack, setPack] = useState<CartAnalyticsResponse | null>(null);
  const [packLoading, setPackLoading] = useState(true);

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

  const loadTree = useCallback(async () => {
    if (!start || !end) return;
    setTreeLoading(true);
    const q = new URLSearchParams({ start, end });
    if (product) q.set("product", product);
    if (utmSource) q.set("utm_source", utmSource);
    if (referrer) q.set("referrer", referrer);
    const res = await fetch(`/api/workspaces/${workspace.id}/funnel-tree?${q.toString()}`);
    if (res.ok) setTree(await res.json());
    setTreeLoading(false);
  }, [workspace.id, start, end, product, utmSource, referrer]);

  useEffect(() => { loadTree(); }, [loadTree]);

  const loadChapter = useCallback(async () => {
    if (!start || !end) return;
    setChapterLoading(true);
    const q = new URLSearchParams({ start, end });
    if (product) q.set("product", product);
    if (utmSource) q.set("utm_source", utmSource);
    if (referrer) q.set("referrer", referrer);
    if (chapterDest) q.set("destination", chapterDest);
    const res = await fetch(`/api/workspaces/${workspace.id}/chapter-diagnostics?${q.toString()}`);
    if (res.ok) setChapter(await res.json());
    setChapterLoading(false);
  }, [workspace.id, start, end, product, utmSource, referrer, chapterDest]);

  useEffect(() => { loadChapter(); }, [loadChapter]);

  const loadWaterfall = useCallback(async () => {
    if (!start || !end) return;
    setWaterfallLoading(true);
    const q = new URLSearchParams({ start, end });
    if (product) q.set("product", product);
    if (utmSource) q.set("utm_source", utmSource);
    if (referrer) q.set("referrer", referrer);
    if (waterfallDest) q.set("destination", waterfallDest);
    const res = await fetch(`/api/workspaces/${workspace.id}/chapter-diagnostics?${q.toString()}`);
    if (res.ok) setWaterfall(await res.json());
    setWaterfallLoading(false);
  }, [workspace.id, start, end, product, utmSource, referrer, waterfallDest]);

  useEffect(() => { loadWaterfall(); }, [loadWaterfall]);

  const loadCart = useCallback(async () => {
    if (!start || !end) return;
    setCartLoading(true);
    const q = new URLSearchParams({ start, end });
    if (product) q.set("product", product);
    if (utmSource) q.set("utm_source", utmSource);
    if (referrer) q.set("referrer", referrer);
    if (cartDest) q.set("destination", cartDest);
    const res = await fetch(`/api/workspaces/${workspace.id}/cart-analytics?${q.toString()}`);
    if (res.ok) setCart(await res.json());
    setCartLoading(false);
  }, [workspace.id, start, end, product, utmSource, referrer, cartDest]);

  useEffect(() => { loadCart(); }, [loadCart]);

  const loadPopup = useCallback(async () => {
    if (!start || !end) return;
    setPopupLoading(true);
    const q = new URLSearchParams({ start, end });
    if (product) q.set("product", product);
    if (utmSource) q.set("utm_source", utmSource);
    if (referrer) q.set("referrer", referrer);
    if (popupDest) q.set("destination", popupDest);
    const res = await fetch(`/api/workspaces/${workspace.id}/cart-analytics?${q.toString()}`);
    if (res.ok) setPopup(await res.json());
    setPopupLoading(false);
  }, [workspace.id, start, end, product, utmSource, referrer, popupDest]);

  useEffect(() => { loadPopup(); }, [loadPopup]);

  const loadSurvey = useCallback(async () => {
    if (!start || !end) return;
    setSurveyLoading(true);
    const q = new URLSearchParams({ start, end });
    if (product) q.set("product", product);
    if (utmSource) q.set("utm_source", utmSource);
    if (referrer) q.set("referrer", referrer);
    if (surveyDest) q.set("destination", surveyDest);
    const res = await fetch(`/api/workspaces/${workspace.id}/cart-analytics?${q.toString()}`);
    if (res.ok) setSurvey(await res.json());
    setSurveyLoading(false);
  }, [workspace.id, start, end, product, utmSource, referrer, surveyDest]);

  useEffect(() => { loadSurvey(); }, [loadSurvey]);

  const loadPack = useCallback(async () => {
    if (!start || !end) return;
    setPackLoading(true);
    const q = new URLSearchParams({ start, end });
    if (product) q.set("product", product);
    if (utmSource) q.set("utm_source", utmSource);
    if (referrer) q.set("referrer", referrer);
    if (packDest) q.set("destination", packDest);
    const res = await fetch(`/api/workspaces/${workspace.id}/cart-analytics?${q.toString()}`);
    if (res.ok) setPack(await res.json());
    setPackLoading(false);
  }, [workspace.id, start, end, product, utmSource, referrer, packDest]);

  useEffect(() => { loadPack(); }, [loadPack]);
  // A page-slice change can change which destinations exist → re-default the cards.
  useEffect(() => { setChapterDest(""); setWaterfallDest(""); setCartDest(""); setPopupDest(""); setSurveyDest(""); setPackDest(""); }, [product, utmSource, referrer]);

  const topOfFunnel = data?.funnel[0]?.sessions ?? 0;
  const orderPlaced = data?.funnel.find(s => s.step === "order_placed")?.sessions ?? 0;
  const addToCart = data?.add_to_cart ?? 0;
  const overallCvr = topOfFunnel > 0 ? (orderPlaced / topOfFunnel) * 100 : 0;
  const atcRate = topOfFunnel > 0 ? (addToCart / topOfFunnel) * 100 : 0;

  return (
    <div className="mx-auto w-full max-w-screen-2xl overflow-x-hidden px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Funnel Stats</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Pixel events from the public storefront. Sessions count distinct visitors per step.
            Conversion rates are based on <strong>PDP visits</strong> (product-page viewers), not total sessions.
          </p>
        </div>
        <DateRangePicker
          preset={preset} setPreset={setPreset}
          start={start} end={end}
          setStart={setStart} setEnd={setEnd}
        />
      </header>

      <SliceFilter
        productOptions={tree?.productOptions ?? []} product={product} onProduct={setProduct}
        utmOptions={tree?.utmSourceOptions ?? []} utmSource={utmSource} onUtmSource={setUtmSource}
        referrerOptions={tree?.referrerOptions ?? []} referrer={referrer} onReferrer={setReferrer}
      />

      <FunnelTreeCard tree={tree} loading={treeLoading} />

      <FunnelWaterfallCard data={waterfall} loading={waterfallLoading} dest={waterfallDest} onDest={setWaterfallDest} />

      <ChapterDiagnosticsCard data={chapter} loading={chapterLoading} dest={chapterDest} onDest={setChapterDest} />

      {loading && !data && (
        <p className="text-sm text-zinc-400">Loading…</p>
      )}

      {data && (
        <>

          <PopupFunnelCard data={popup} loading={popupLoading} dest={popupDest} onDest={setPopupDest} destOptions={chapter?.availableDestinations ?? []} />
          <SurveyFunnelCard data={survey} loading={surveyLoading} dest={surveyDest} onDest={setSurveyDest} destOptions={chapter?.availableDestinations ?? []} />

          {tree && (
            <div className="mb-8 grid gap-4 lg:grid-cols-3">
              <BreakdownPanel title="Device" rows={tree.breakdowns.device} />
              <BreakdownPanel title="Country" rows={tree.breakdowns.country} />
              <BreakdownPanel title="Language" rows={tree.breakdowns.language} />
            </div>
          )}

          <CartAnalyticsCard data={cart} loading={cartLoading} dest={cartDest} onDest={setCartDest} destOptions={chapter?.availableDestinations ?? []} />

          {data.runningExperiments && data.runningExperiments.length > 0 && (
            <RunningExperimentsPanel rows={data.runningExperiments} />
          )}

          {data.leverImportance && (
            <LeverImportancePanel rows={data.leverImportance} />
          )}

          {data.campaignGrades && (data.campaignGrades.rows.length > 0 || data.campaignGrades.proposed_rules.length > 0) && (
            <CampaignGradesPanel block={data.campaignGrades} workspaceId={workspace.id} onChange={load} />
          )}

          <PackBreakdownCard data={pack} loading={packLoading} dest={packDest} onDest={setPackDest} destOptions={chapter?.availableDestinations ?? []} />

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

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "good" | "neutral" | "bad" }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${tone === "good" ? "text-emerald-600" : tone === "bad" ? "text-rose-600" : "text-zinc-900 dark:text-zinc-100"}`}>
        {value}
      </p>
    </div>
  );
}







function RunningExperimentsPanel({ rows }: { rows: NonNullable<FunnelData["runningExperiments"]> }) {
  const cvr = (a: { conversions: number; sessions: number }) =>
    a.sessions > 0 ? `${Math.round((a.conversions / a.sessions) * 1000) / 10}%` : "—";
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">
        Running experiments
      </h2>
      <div className="space-y-5">
        {rows.map((exp) => (
          <div key={exp.experiment_id} className="rounded-md border border-zinc-100 p-3 dark:border-zinc-800/60">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                {exp.lever} <span className="text-zinc-400">· {exp.lander_type}</span>
              </span>
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-800">
                {exp.status} · {Math.round(exp.holdout_pct * 100)}% holdout
              </span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
                  <th className="py-1 pr-2">Arm</th>
                  <th className="py-1 pr-2 text-right">Sessions</th>
                  <th className="py-1 pr-2 text-right">CVR</th>
                  <th className="py-1 pr-2 text-right">Sub-attach</th>
                  <th className="py-1 pr-2 text-right">Win-prob vs control</th>
                </tr>
              </thead>
              <tbody>
                {exp.arms.map((a) => (
                  <tr key={a.variant_id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                    <td className="py-1 pr-2 text-zinc-900 dark:text-zinc-100">
                      {a.label}
                      {a.is_control && <span className="ml-1 text-[10px] uppercase text-zinc-400">control</span>}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">{a.sessions.toLocaleString()}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{cvr(a)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{a.sub_attach.toLocaleString()}</td>
                    <td className="py-1 pr-2 text-right font-semibold tabular-nums">
                      {a.win_prob === null ? "—" : `${Math.round(a.win_prob * 100)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
}

function LeverImportancePanel({ rows }: { rows: NonNullable<FunnelData["leverImportance"]> }) {
  // What the agent believes matters: the learned lever-importance posteriors. A bar
  // shows current importance; the delta vs prior shows what testing taught it.
  const fmtLever = (s: string) => s.replace(/[-_]/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
  const fmtAgo = (iso: string | null) => {
    if (!iso) return "never";
    const days = Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
    return days <= 0 ? "today" : `${days}d ago`;
  };
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          What the agent believes matters
        </h2>
        <span className="text-[11px] text-zinc-400">
          Learned lever importance per (product × lander × audience) — updated by each experiment, win or loss.
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-zinc-400">
          No learnings yet — every concluded experiment commits one here, win or loss.
        </p>
      ) : (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
              <th className="py-2 pr-2">Lever</th>
              <th className="py-2 pr-2">Lander</th>
              <th className="py-2 pr-2">Scope</th>
              <th className="py-2 pr-2 text-right">Importance</th>
              <th className="py-2 pr-2 text-right">vs prior</th>
              <th className="py-2 pr-2 text-right">Tests</th>
              <th className="py-2 pr-2 text-right">Last tested</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const delta = Math.round((r.importance - r.prior) * 1000) / 1000;
              return (
                <tr key={`${r.lever_key}-${r.product_id}-${r.lander_type}-${r.audience}-${i}`} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                  <td className="py-2 pr-2 text-zinc-900 dark:text-zinc-100">
                    {fmtLever(r.lever_key)}
                    <span className="ml-1 text-[10px] uppercase text-zinc-400">{r.chapter}</span>
                  </td>
                  <td className="py-2 pr-2 text-zinc-500">{r.lander_type}</td>
                  <td className="py-2 pr-2">
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-800">
                      {r.scope === "general" ? "general" : "product"}
                    </span>
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                    <div className="flex items-center justify-end gap-2">
                      <div className="hidden h-1.5 w-20 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800 sm:block">
                        <div className="h-full bg-zinc-900 dark:bg-zinc-100" style={{ width: `${Math.round(r.importance * 100)}%` }} />
                      </div>
                      {r.importance.toFixed(2)}
                    </div>
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums font-semibold">
                    <span className={delta > 0.01 ? "text-emerald-600" : delta < -0.01 ? "text-rose-600" : "text-zinc-400"}>
                      {delta > 0 ? "+" : ""}{delta.toFixed(2)}
                    </span>
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums text-zinc-500">{r.n_tests}</td>
                  <td className="py-2 pr-2 text-right tabular-nums text-zinc-500">{fmtAgo(r.last_tested_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </section>
  );
}

function CampaignGradesPanel({
  block,
  workspaceId,
  onChange,
}: {
  block: NonNullable<FunnelData["campaignGrades"]>;
  workspaceId: string;
  onChange: () => void;
}) {
  // The M5 Head-of-Growth report: every concluded campaign with its initial + revised grade,
  // hypothesis/result sub-scores, the agent's average-grade trend, and a one-click override.
  // Hypothesis quality is scored SEPARATELY from result — a sound bet that lost grades high.
  const [editing, setEditing] = useState<string | null>(null);
  const [editGrade, setEditGrade] = useState<number>(5);
  const [editReason, setEditReason] = useState("");
  const [editAxis, setEditAxis] = useState<"initial" | "revised">("initial");
  const [proposeRule, setProposeRule] = useState(false);
  const [busy, setBusy] = useState(false);

  const fmtLever = (s: string) => s.replace(/[-_]/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
  const gradeTone = (g: number | null) =>
    g === null ? "text-zinc-400" : g >= 8 ? "text-emerald-600" : g >= 6 ? "text-zinc-900 dark:text-zinc-100" : g >= 4 ? "text-amber-600" : "text-rose-600";

  // Average-grade trend direction: compare the mean of the first vs the second half.
  const trend = block.trend;
  let trendDir: "up" | "down" | "flat" | null = null;
  if (trend.length >= 4) {
    const mid = Math.floor(trend.length / 2);
    const mean = (arr: typeof trend) => arr.reduce((a, t) => a + t.grade, 0) / (arr.length || 1);
    const first = mean(trend.slice(0, mid));
    const second = mean(trend.slice(mid));
    trendDir = second - first > 0.3 ? "up" : second - first < -0.3 ? "down" : "flat";
  }

  async function submitOverride(gradeId: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/storefront-campaign-grades/${gradeId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grade: editGrade, reason: editReason, axis: editAxis, propose_rule: proposeRule }),
      });
      if (res.ok) {
        setEditing(null);
        setEditReason("");
        setProposeRule(false);
        onChange();
      }
    } finally {
      setBusy(false);
    }
  }

  async function reviewRule(ruleId: string, status: "approved" | "rejected") {
    setBusy(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/storefront-grader-prompts/${ruleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.ok) onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          Campaign grades — Head of Growth
        </h2>
        <span className="text-[11px] text-zinc-400">
          The agent&apos;s feedback signal. Hypothesis quality is graded <strong>separately</strong> from result — a sound bet that lost grades high.
        </span>
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">Avg grade</p>
          <p className="mt-1 flex items-baseline gap-2 text-2xl font-bold tabular-nums">
            <span className={gradeTone(block.avg_grade)}>{block.avg_grade ?? "—"}</span>
            {trendDir && (
              <span className={`text-xs font-semibold ${trendDir === "up" ? "text-emerald-600" : trendDir === "down" ? "text-rose-600" : "text-zinc-400"}`}>
                {trendDir === "up" ? "↑ trending up" : trendDir === "down" ? "↓ trending down" : "→ flat"}
              </span>
            )}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">Avg hypothesis quality</p>
          <p className={`mt-1 text-2xl font-bold tabular-nums ${gradeTone(block.avg_hypothesis_quality)}`}>{block.avg_hypothesis_quality ?? "—"}</p>
        </div>
        <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">Graded campaigns</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100">{block.graded}</p>
        </div>
      </div>

      {block.proposed_rules.length > 0 && (
        <div className="mb-5 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-950/30">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
            Proposed calibration rules — approve to apply
          </p>
          <ul className="space-y-2">
            {block.proposed_rules.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 text-xs">
                <div>
                  <p className="font-semibold text-zinc-900 dark:text-zinc-100">{r.title}</p>
                  <p className="text-zinc-600 dark:text-zinc-400">{r.content}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button disabled={busy} onClick={() => reviewRule(r.id, "approved")} className="rounded bg-emerald-600 px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-50">Approve</button>
                  <button disabled={busy} onClick={() => reviewRule(r.id, "rejected")} className="rounded bg-zinc-200 px-2 py-1 text-[10px] font-semibold text-zinc-700 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-300">Reject</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {block.rows.length === 0 ? (
        <p className="text-xs text-zinc-400">No campaigns graded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
                <th className="py-2 pr-2">Campaign (lever)</th>
                <th className="py-2 pr-2 text-right">Hypothesis</th>
                <th className="py-2 pr-2 text-right">Result</th>
                <th className="py-2 pr-2 text-right">Initial</th>
                <th className="py-2 pr-2 text-right">Revised</th>
                <th className="py-2 pr-2">By</th>
                <th className="py-2 pr-2"></th>
              </tr>
            </thead>
            <tbody>
              {block.rows.map((r) => (
                <Fragment key={r.grade_id}>
                  <tr className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                    <td className="py-2 pr-2 text-zinc-900 dark:text-zinc-100">
                      {fmtLever(r.lever)}
                      <span className="ml-1 text-[10px] uppercase text-zinc-400">{r.product_title} · {r.lander_type} · {r.status}</span>
                    </td>
                    <td className={`py-2 pr-2 text-right font-semibold tabular-nums ${gradeTone(r.hypothesis_quality)}`}>{r.hypothesis_quality ?? "—"}</td>
                    <td className={`py-2 pr-2 text-right tabular-nums ${gradeTone(r.result_quality)}`}>{r.result_quality ?? "—"}</td>
                    <td className={`py-2 pr-2 text-right font-semibold tabular-nums ${gradeTone(r.grade_initial)}`}>{r.grade_initial ?? "—"}</td>
                    <td className={`py-2 pr-2 text-right font-semibold tabular-nums ${gradeTone(r.grade_revised)}`}>{r.grade_revised ?? <span className="text-zinc-300">pending</span>}</td>
                    <td className="py-2 pr-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${r.graded_by === "human" ? "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"}`}>
                        {r.graded_by}
                      </span>
                    </td>
                    <td className="py-2 pr-2 text-right">
                      <button
                        onClick={() => {
                          setEditing(editing === r.grade_id ? null : r.grade_id);
                          setEditGrade(r.grade_revised ?? r.grade_initial ?? 5);
                          setEditAxis(r.grade_revised != null ? "revised" : "initial");
                          setEditReason("");
                          setProposeRule(false);
                        }}
                        className="rounded border border-zinc-300 px-2 py-1 text-[10px] font-semibold text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      >
                        {editing === r.grade_id ? "Cancel" : "Override"}
                      </button>
                    </td>
                  </tr>
                  {editing === r.grade_id && (
                    <tr className="border-b border-zinc-100 dark:border-zinc-800/50">
                      <td colSpan={7} className="bg-zinc-50 px-3 py-3 dark:bg-zinc-900/60">
                        {(r.grade_initial_reasoning || r.grade_revised_reasoning) && (
                          <p className="mb-2 text-[11px] text-zinc-500">
                            <span className="font-semibold">Grader reasoning:</span> {r.grade_revised_reasoning || r.grade_initial_reasoning}
                          </p>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          <select value={editAxis} onChange={(e) => setEditAxis(e.target.value as "initial" | "revised")} className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900">
                            <option value="initial">Initial grade</option>
                            <option value="revised">Revised grade</option>
                          </select>
                          <label className="text-xs text-zinc-500">to</label>
                          <select value={editGrade} onChange={(e) => setEditGrade(Number(e.target.value))} className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900">
                            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => <option key={n} value={n}>{n}/10</option>)}
                          </select>
                          <input
                            value={editReason}
                            onChange={(e) => setEditReason(e.target.value)}
                            placeholder="Why? (recorded as the override reason)"
                            className="min-w-[240px] flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                          />
                          <label className="flex items-center gap-1 text-[11px] text-zinc-500">
                            <input type="checkbox" checked={proposeRule} onChange={(e) => setProposeRule(e.target.checked)} />
                            propose calibration rule
                          </label>
                          <button
                            disabled={busy || !editReason.trim()}
                            onClick={() => submitOverride(r.grade_id)}
                            className="rounded bg-zinc-900 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                          >
                            {busy ? "Saving…" : "Save override"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

