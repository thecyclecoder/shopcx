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
  order_placed: number; add_to_cart: number;
  engagement_rate: number; conversion_rate: number; atc_rate: number;
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
  productOptions: Array<{ handle: string; title: string; sessions: number }>;
  utmSourceOptions: Array<{ source: string; label: string; sessions: number }>;
  referrerOptions: Array<{ referrer: string; label: string; sessions: number }>;
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
              Bare PDP vs targeted landers, rolled up per product. {tree.grandTotal.visit.toLocaleString()} visits · {pctStr(tree.grandTotal.conversion_rate)} CVR · {tree.range.start} → {tree.range.end}
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
                <th className="py-2 text-right font-medium">Eng %</th>
                <th className="py-2 text-right font-medium">CVR</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={8} className="py-3 text-sm text-zinc-400">No sessions in this window.</td></tr>
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
                    <td className="py-1.5 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{m.engaged.toLocaleString()}</td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{m.pack_selected.toLocaleString()}</td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{m.checkout_started.toLocaleString()}</td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-900 dark:text-zinc-100">{m.order_placed.toLocaleString()}</td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{pctStr(m.engagement_rate)}</td>
                    <td className={"py-1.5 text-right tabular-nums font-medium " + (m.conversion_rate > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-400")}>{pctStr(m.conversion_rate)}</td>
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

      {loading && !data && (
        <p className="text-sm text-zinc-400">Loading…</p>
      )}

      {data && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Total sessions" value={data.total_sessions.toLocaleString()} />
            <StatCard label="PDP visits" value={topOfFunnel.toLocaleString()} />
            <StatCard label="Add-to-cart rate" value={`${atcRate.toFixed(1)}%`} tone={atcRate >= 5 ? "good" : "neutral"} />
            <StatCard label="Leads generated" value={(data.leads_generated ?? 0).toLocaleString()} tone={(data.leads_generated ?? 0) > 0 ? "good" : "neutral"} />
            <StatCard label="Orders" value={orderPlaced.toLocaleString()} />
            <StatCard
              label="PDP → order"
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

          {data.popupFunnel && <PopupFunnelPanel data={data.popupFunnel} />}
          {data.surveyFunnel && <SurveyFunnelPanel data={data.surveyFunnel} />}

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

          {data.chapterPerformance && data.chapterPerformance.length > 0 && (
            <ChapterPerformancePanel rows={data.chapterPerformance} />
          )}

          {data.abandonedCarts && (
            <AbandonedCartsPanel block={data.abandonedCarts} />
          )}

          {data.predictedLtv && data.predictedLtv.length > 0 && (
            <PredictedLtvPanel rows={data.predictedLtv} />
          )}

          {data.runningExperiments && data.runningExperiments.length > 0 && (
            <RunningExperimentsPanel rows={data.runningExperiments} />
          )}

          {data.leverImportance && (
            <LeverImportancePanel rows={data.leverImportance} />
          )}

          {data.campaignGrades && (data.campaignGrades.rows.length > 0 || data.campaignGrades.proposed_rules.length > 0) && (
            <CampaignGradesPanel block={data.campaignGrades} workspaceId={workspace.id} onChange={load} />
          )}

          <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">
              Top products (by pack_selected)
            </h2>
            {data.topProducts.length === 0 ? (
              <p className="text-xs text-zinc-400">No pack selections in this range yet.</p>
            ) : (
              <div className="overflow-x-auto">
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
              </div>
            )}
          </section>

          {data.packBreakdown && data.packBreakdown.length > 0 && (
            <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">
                Pack size chosen
              </h2>
              {(() => {
                const total = data.packBreakdown.reduce((s, b) => s + b.count, 0) || 1;
                return (
                  <div className="space-y-2">
                    {data.packBreakdown.map(b => (
                      <div key={b.label} className="flex items-center gap-3">
                        <div className="w-28 shrink-0 text-sm text-zinc-700 dark:text-zinc-300">{b.label}</div>
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.round((b.count / total) * 100)}%` }} />
                        </div>
                        <div className="w-20 shrink-0 text-right text-sm tabular-nums text-zinc-900 dark:text-zinc-100">
                          <span className="font-semibold">{b.count}</span>
                          <span className="ml-1 text-xs text-zinc-400">{Math.round((b.count / total) * 100)}%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </section>
          )}

          <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">
              Recent events (last 30)
            </h2>
            {data.recentEvents.length === 0 ? (
              <p className="text-xs text-zinc-400">No events in this range.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-xs">
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
                        <td className="py-2 pr-2 text-zinc-600 dark:text-zinc-400" title={e.url || ""}>
                          <div className="max-w-[260px] truncate">
                            {e.url ? new URL(e.url).pathname + new URL(e.url).search : "—"}
                          </div>
                        </td>
                        <td className="py-2 pr-2 font-mono text-[10px] text-zinc-500" title={JSON.stringify(e.meta)}>
                          <div className="max-w-[260px] truncate">
                            {e.meta && Object.keys(e.meta).length > 0 ? JSON.stringify(e.meta) : "—"}
                          </div>
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
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-sm">
              <span className="min-w-0 truncate font-semibold text-zinc-900 dark:text-zinc-100">
                {STEP_LABELS[row.step] || row.step}
              </span>
              <div className="flex flex-wrap items-center justify-end gap-x-3 tabular-nums">
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

function PopupFunnelPanel({ data }: { data: NonNullable<FunnelData["popupFunnel"]> }) {
  const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—");
  const rows = [
    ...data.byVariant.map((v) => ({ ...v, isTotal: false })),
    { variant: "total", label: "Total", ...data.totals, isTotal: true },
  ];
  // A cell shows the count and, beneath it, its share of that row's "shown".
  const Cell = ({ n, shown, pctLabel }: { n: number; shown: number; pctLabel?: string }) => (
    <td className="py-2 pr-2 text-right tabular-nums">
      <span className="font-semibold text-zinc-900 dark:text-zinc-100">{n.toLocaleString()}</span>
      {pctLabel !== "" && <span className="ml-1.5 text-xs text-zinc-400">{pctLabel ?? pct(n, shown)}</span>}
    </td>
  );
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          Lead-capture popup
        </h2>
        <span className="text-[11px] text-zinc-400">
          Offer = discount variant · Survey = quiz variant · % is of that row&apos;s shown
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[600px] text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
              <th className="py-2 pr-2">Variant</th>
              <th className="py-2 pr-2 text-right">Shown</th>
              <th className="py-2 pr-2 text-right">Engaged</th>
              <th className="py-2 pr-2 text-right">Email (step 1)</th>
              <th className="py-2 pr-2 text-right">Phone (step 2)</th>
              <th className="py-2 pr-2 text-right">Email→Phone</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.variant}
                className={`border-b border-zinc-100 last:border-0 dark:border-zinc-800/50 ${r.isTotal ? "font-semibold" : ""}`}
              >
                <td className="py-2 pr-2 text-zinc-900 dark:text-zinc-100">{r.label}</td>
                <Cell n={r.shown} shown={r.shown} pctLabel="" />
                <Cell n={r.engaged} shown={r.shown} />
                <Cell n={r.email} shown={r.shown} />
                <Cell n={r.phone} shown={r.shown} />
                <td className="py-2 pr-2 text-right tabular-nums">
                  <span className={r.email > 0 ? "font-semibold text-emerald-600" : "text-zinc-400"}>
                    {pct(r.phone, r.email)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SurveyFunnelPanel({ data }: { data: NonNullable<FunnelData["surveyFunnel"]> }) {
  const { shown, completed, email, phone } = data;
  const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—");
  const steps = [
    { label: "Shown", n: shown, of: shown },
    { label: "Completed survey", n: completed, of: shown },
    { label: "Email (step 1)", n: email, of: shown },
    { label: "Phone (step 2)", n: phone, of: shown },
  ];
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">Survey chapter</h2>
        <span className="text-[11px] text-zinc-400">In-page survey after the hero · % is of shown</span>
      </div>
      {shown === 0 ? (
        <p className="text-xs text-zinc-400">No survey impressions in this range yet.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {steps.map((s, i) => (
            <div key={s.label} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">{s.label}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100">{s.n.toLocaleString()}</p>
              {i > 0 && <p className="text-xs text-zinc-400">{pct(s.n, s.of)} of shown</p>}
            </div>
          ))}
        </div>
      )}
    </section>
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
                <span className="min-w-0 truncate text-zinc-700 dark:text-zinc-300">{r.label}</span>
                <span className="ml-2 shrink-0 tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">{r.value}</span>
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

function AbandonedCartsPanel({ block }: { block: AbandonedCartsBlock }) {
  const recoveredPct = block.recovery_rate_pct;
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          Abandoned carts
        </h2>
        <span className="text-[11px] text-zinc-400">
          Reminder fires after 30 min idle, once per cart.
        </span>
      </div>
      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatCard label="Open now (has email)" value={block.open_with_email.toLocaleString()} />
        <StatCard label="Reminders sent" value={block.emailed.toLocaleString()} />
        <StatCard
          label="Recovered"
          value={block.recovered.toLocaleString()}
          tone={block.recovered > 0 ? "good" : "neutral"}
        />
        <StatCard
          label="Recovery rate"
          value={`${recoveredPct.toFixed(1)}%`}
          tone={recoveredPct >= 5 ? "good" : "neutral"}
        />
      </div>
      <div className="mb-4 rounded-md border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300">
        Revenue recovered:&nbsp;
        <strong>${(block.revenue_recovered_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
      </div>
      {block.recent.length === 0 ? (
        <p className="text-xs text-zinc-400">No abandoned carts in this range yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
                <th className="py-2 pr-2">Created</th>
                <th className="py-2 pr-2">Email</th>
                <th className="py-2 pr-2">Items</th>
                <th className="py-2 pr-2 text-right">Subtotal</th>
                <th className="py-2 pr-2">Reminder</th>
                <th className="py-2 pr-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {block.recent.map(c => (
                <tr key={c.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                  <td className="whitespace-nowrap py-2 pr-2 text-zinc-500">
                    {new Date(c.created_at).toLocaleString()}
                  </td>
                  <td className="py-2 pr-2 text-zinc-900 dark:text-zinc-100">{c.email}</td>
                  <td className="py-2 pr-2 tabular-nums text-zinc-700 dark:text-zinc-300">{c.item_count}</td>
                  <td className="py-2 pr-2 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                    ${(c.subtotal_cents / 100).toFixed(2)}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-2 text-xs text-zinc-500">
                    {c.abandoned_email_sent_at
                      ? new Date(c.abandoned_email_sent_at).toLocaleString()
                      : <span className="text-amber-600">pending</span>}
                  </td>
                  <td className="py-2 pr-2">
                    {c.status === "converted" ? (
                      <span className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-100 text-emerald-800">recovered</span>
                    ) : c.status === "abandoned" ? (
                      <span className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold bg-zinc-100 text-zinc-600">abandoned</span>
                    ) : (
                      <span className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-800">open</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PredictedLtvPanel({ rows }: { rows: NonNullable<FunnelData["predictedLtv"]> }) {
  // The M3 reward the bandit optimizes: predicted lifetime MARGIN per exposed visitor per
  // (product × lander × audience), shown week-over-week. While uncalibrated the proxy hasn't
  // been truth-checked by the 4-month reconciler, so the bandit bets conservatively.
  const money = (cents: number) => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const anyUncalibrated = rows.some((r) => !r.calibrated);
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          Predicted LTV per visitor
        </h2>
        <span className="text-[11px] text-zinc-400">
          The reward the agent optimizes — predicted lifetime margin per visitor, week-over-week.
          {anyUncalibrated && (
            <span className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
              uncalibrated — betting conservatively
            </span>
          )}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
              <th className="py-2 pr-2">Cohort</th>
              <th className="py-2 pr-2 text-right">Visitors</th>
              <th className="py-2 pr-2 text-right">Sub-attach</th>
              <th className="py-2 pr-2 text-right">Est sub-LTV</th>
              <th className="py-2 pr-2 text-right">Pred. LTV/visitor</th>
              <th className="py-2 pr-2 text-right">vs last wk</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const wow = r.wow_delta_pct;
              return (
                <tr key={`${r.product_id}-${r.lander_type}-${r.audience}-${i}`} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                  <td className="py-2 pr-2 text-zinc-900 dark:text-zinc-100">
                    {r.product_title}
                    <span className="ml-1 text-[10px] uppercase text-zinc-400">{r.lander_type} · {r.audience}</span>
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums text-zinc-500">{r.visitors.toLocaleString()}</td>
                  <td className="py-2 pr-2 text-right tabular-nums text-zinc-500">{Math.round(r.sub_attach_rate * 1000) / 10}%</td>
                  <td className="py-2 pr-2 text-right tabular-nums text-zinc-500">{money(r.est_sub_ltv_cents)}</td>
                  <td className="py-2 pr-2 text-right font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{money(r.predicted_ltv_per_visitor_cents)}</td>
                  <td className="py-2 pr-2 text-right tabular-nums font-semibold">
                    {wow === null ? (
                      <span className="text-zinc-400">—</span>
                    ) : (
                      <span className={wow > 0.1 ? "text-emerald-600" : wow < -0.1 ? "text-rose-600" : "text-zinc-400"}>
                        {wow > 0 ? "+" : ""}{wow}%
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
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

function ChapterPerformancePanel({ rows }: { rows: NonNullable<FunnelData["chapterPerformance"]> }) {
  const maxReach = Math.max(...rows.map(r => r.reach_sessions), 1);
  const fmtChapter = (c: string) => c.replace(/[-_]/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
  const fmtDwell = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          Chapter performance
        </h2>
        <span className="text-[11px] text-zinc-400">
          View→pricing % = of sessions that read a chapter, how many clicked through to pricing from it.
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
              <th className="py-2 pr-2">Chapter</th>
              <th className="py-2 pr-2 text-right">Reach</th>
              <th className="py-2 pr-2 text-right">Reach %</th>
              <th className="py-2 pr-2 text-right">Avg dwell</th>
              <th className="py-2 pr-2 text-right">→ Pricing</th>
              <th className="py-2 pr-2 text-right">View→pricing %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.chapter} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                <td className="py-2 pr-2 text-zinc-900 dark:text-zinc-100">{fmtChapter(r.chapter)}</td>
                <td className="py-2 pr-2 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                  <div className="flex items-center justify-end gap-2">
                    <div className="hidden h-1.5 w-16 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800 sm:block">
                      <div className="h-full bg-zinc-900 dark:bg-zinc-100" style={{ width: `${(r.reach_sessions / maxReach) * 100}%` }} />
                    </div>
                    {r.reach_sessions.toLocaleString()}
                  </div>
                </td>
                <td className="py-2 pr-2 text-right tabular-nums text-zinc-500">{r.reach_rate_pct.toFixed(1)}%</td>
                <td className="py-2 pr-2 text-right tabular-nums text-zinc-500">{fmtDwell(r.avg_dwell_ms)}</td>
                <td className="py-2 pr-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{r.scroll_to_price_sessions.toLocaleString()}</td>
                <td className="py-2 pr-2 text-right tabular-nums font-semibold">
                  <span className={r.view_to_cta_pct >= 15 ? "text-emerald-600" : r.view_to_cta_pct > 0 ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-400"}>
                    {r.view_to_cta_pct.toFixed(1)}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EventChip({ type }: { type: string }) {
  const tone: Record<string, string> = {
    pdp_view: "bg-zinc-100 text-zinc-700",
    pdp_engaged: "bg-amber-100 text-amber-800",
    chapter_view: "bg-sky-50 text-sky-700",
    chapter_dwell: "bg-sky-50 text-sky-600",
    scroll_depth: "bg-zinc-100 text-zinc-600",
    cta_click: "bg-orange-100 text-orange-800",
    add_to_cart: "bg-blue-100 text-blue-800",
    pack_selected: "bg-blue-100 text-blue-800",
    customize_view: "bg-indigo-100 text-indigo-800",
    upsell_added: "bg-emerald-100 text-emerald-800",
    upsell_skipped: "bg-zinc-100 text-zinc-600",
    checkout_view: "bg-violet-100 text-violet-800",
    checkout_redirect: "bg-violet-100 text-violet-800",
    order_placed: "bg-emerald-200 text-emerald-900 font-bold",
  };
  return (
    <span className={`inline-flex whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone[type] || "bg-zinc-100 text-zinc-700"}`}>
      {type}
    </span>
  );
}
