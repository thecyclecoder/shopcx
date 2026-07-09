/**
 * Growth Director analytical brief — Phase 1 (growth-director-analytical-brief spec).
 *
 * Read-only cross-cohort scorecard the Director will reason over (Phase 2). One row
 * per (cohort, creative, destination) that JOINS the Meta side + the on-site funnel
 * + per-variant ROAS at a single grain so a high-CTR / zero-ATC pattern becomes a
 * first-class field instead of two dashboards Dylan has to read side-by-side.
 *
 *   - Cohort       ← the product handle the ad's `ad_campaigns.product_id` resolves
 *                     to (via `ad_publish_jobs.meta_ad_id -> ad_publish_jobs.campaign_id
 *                     -> ad_campaigns.product_id -> products.handle`). Ads that don't
 *                     resolve (direct-in-Meta setups) land in the sentinel `unknown`
 *                     cohort so spend is never dropped.
 *   - Creative     ← the Meta ad row (`meta_ads.meta_ad_id` — the same id both
 *                     [[meta_insights_daily]] and [[meta_attribution_daily]] key on,
 *                     and the same id `storefront_sessions.utm_content` carries by
 *                     publish-time convention — see [[../inngest/ad-tool]]).
 *   - Destination  ← the ad's `landing_url` (from `ad_publish_jobs.destination_url`).
 *
 * ── Sources (all rolled up over `[startIso, endIso]`) ─────────────────────────
 *   - Meta metrics (spend / impressions / clicks / CTR / CPC / CPM / frequency /
 *     purchases / revenue) → [[meta_insights_daily]] `level='ad'`.
 *   - On-site funnel (landing_page_views / add_to_carts / initiate_checkouts /
 *     purchases) → [[storefront_events]] keyed to the ad's sessions via
 *     `storefront_sessions.utm_content = meta_ad_id`. Uses the same real-traffic
 *     exclusion as the funnel-tree ([[../libraries/funnel-tree]]) — internal /
 *     bot / internal-customer sessions dropped.
 *   - Per-variant ROAS → [[meta_attribution_daily]] `(meta_ad_id, variant)` at ad
 *     grain, rolled to spend / revenue / roas / sessions / orders per variant.
 *
 * ── Cohort filter ─────────────────────────────────────────────────────────────
 * Callers scope the brief by product handle (`opts.productHandles=['amazing-coffee',
 * 'tabs']`) — the shape the verification asserts. The default (no filter) surfaces
 * every cohort with in-window Meta spend for the workspace, matching the spec's
 * "covers all live media-buyer cohorts" mandate.
 *
 * ── Drop-off, as a first-class field ──────────────────────────────────────────
 * `dropoffs` carries every stage-to-stage gap the Director hunts for: the RATE
 * (child ÷ parent, 0..1) and the ABSOLUTE gap (parent − child). A creative with
 * clicks but no carts shows a visible LPV→ATC cliff — that's the spec's live-read
 * Tabs case, and the shape the Phase-2 hypothesis generator will read.
 *
 * See docs/brain/specs/growth-director-analytical-brief.md · brain page
 * [[../libraries/growth-director-analytical-brief]].
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** How large a slice of Meta ads the brief covers per call. */
const MAX_ADS_IN_BRIEF = 500;

/** The unresolved sentinel — an ad with no matching `ad_publish_jobs` → `ad_campaigns` → product row.
 *  Spend is never dropped; the Director reads the sentinel row to notice direct-in-Meta setups. */
export const UNKNOWN_COHORT = "unknown";

// ── Public shape ─────────────────────────────────────────────────────────────

/** Meta-side rollup over the window at `level='ad'` grain. */
export interface CreativeMetaMetrics {
  spend_cents: number;
  impressions: number;
  clicks: number;
  /** CTR ×100 (Meta's percent basis — mirrors `meta_insights_daily.ctr`). */
  ctr: number;
  cpc_cents: number;
  /** CPM ×100 (dollars ×100 per 1k impressions) — derived, not stored on the source. */
  cpm_cents: number;
  /** Average frequency across the window's daily rows (weighted by day, not spend). */
  frequency: number;
  purchases: number;
  revenue_cents: number;
  /** `revenue_cents / spend_cents` — 0 when no spend. */
  roas: number;
  /** `spend_cents / purchases` — null when no purchases. */
  cpa_cents: number | null;
}

/** On-site funnel counts for this creative's Meta sessions (utm_content = meta_ad_id). */
export interface CreativeFunnel {
  /** distinct sessions that fired `pdp_view` (the spec's LPV term). */
  landing_page_views: number;
  /** distinct sessions that fired `add_to_cart`. */
  add_to_carts: number;
  /** distinct sessions that fired `checkout_view` (Meta's initiate_checkout equivalent). */
  initiate_checkouts: number;
  /** distinct sessions that fired `order_placed` on-site. */
  purchases: number;
}

/** Stage-to-stage drop-off — the SPEC'S first-class field. */
export interface CreativeDropoffs {
  /** `add_to_carts / landing_page_views` (0..1). null when the parent is 0. */
  lpv_to_atc_rate: number | null;
  /** `initiate_checkouts / add_to_carts` (0..1). null when the parent is 0. */
  atc_to_checkout_rate: number | null;
  /** `purchases / initiate_checkouts` (0..1). null when the parent is 0. */
  checkout_to_purchase_rate: number | null;
  /** Absolute session gap `landing_page_views - add_to_carts`. */
  lpv_to_atc_gap: number;
  /** Absolute session gap `add_to_carts - initiate_checkouts`. */
  atc_to_checkout_gap: number;
  /** Absolute session gap `initiate_checkouts - purchases`. */
  checkout_to_purchase_gap: number;
}

/** Per-variant unit economics — the Phase-2 "format-effectiveness-by-product" signal. */
export interface VariantAttribution {
  /** `advertorial` | `beforeafter` | `reasons` | `(unresolved)` — matches [[meta_attribution_daily]]. */
  variant: string;
  spend_cents: number;
  revenue_cents: number;
  /** `revenue_cents / spend_cents` — 0 when no spend. */
  roas: number;
  sessions: number;
  orders: number;
}

/** One (cohort, creative, destination) row — the atomic scorecard grain. */
export interface CreativeScorecardRow {
  /** product handle — e.g. `amazing-coffee`. `UNKNOWN_COHORT` for unresolvable ads. */
  cohort: string;
  /** product title when known, else the handle (or `Unknown cohort`). */
  cohort_label: string;
  /** the Meta ad id (also `storefront_sessions.utm_content`). */
  meta_ad_id: string;
  meta_ad_name: string | null;
  /** parent Meta adset (context, from `meta_ads`). */
  meta_adset_id: string | null;
  /** parent Meta campaign (context, from `meta_ads`). */
  meta_campaign_id: string | null;
  /** the ad's click-through URL (from `ad_publish_jobs.destination_url`). null when never published through the tool. */
  destination_url: string | null;
  meta: CreativeMetaMetrics;
  funnel: CreativeFunnel;
  dropoffs: CreativeDropoffs;
  variants: VariantAttribution[];
}

/** Per-cohort rollup — totals across every creative in the cohort. */
export interface CohortSummary {
  cohort: string;
  cohort_label: string;
  creatives: number;
  totals: CreativeMetaMetrics & CreativeFunnel;
}

export interface AnalyticalBriefResult {
  workspaceId: string;
  windowStartIso: string;
  windowEndIso: string;
  cohorts: CohortSummary[];
  rows: CreativeScorecardRow[];
  /** Diagnostic — every meta_ad_id that hit Meta insights but couldn't be resolved to a product cohort. */
  unresolvedAdIds: string[];
}

export interface AnalyticalBriefParams {
  admin: Admin;
  workspaceId: string;
  /** ISO instants — the caller owns the Central-time boundary math. */
  startIso: string;
  endIso: string;
  /** Restrict to specific product handles (e.g. `['amazing-coffee','tabs']`); default = every cohort with spend. */
  productHandles?: string[];
  /** Cap the number of creative rows returned (default `MAX_ADS_IN_BRIEF`) — the Phase-2 prompt caps its own read. */
  limit?: number;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

const round = (n: number, p = 4): number => Number(n.toFixed(p));
const nullOr = (n: number | null): number | null => (n == null || !Number.isFinite(n) ? null : n);

/** Compute the drop-off fields from a funnel count set. Exposed for the Phase-2 hypothesis
 *  generator to reuse — and the unit test to assert the LPV→ATC cliff signal. */
export function computeDropoffs(f: CreativeFunnel): CreativeDropoffs {
  const rate = (num: number, den: number): number | null =>
    den > 0 ? round(Math.max(0, Math.min(1, num / den))) : null;
  return {
    lpv_to_atc_rate: rate(f.add_to_carts, f.landing_page_views),
    atc_to_checkout_rate: rate(f.initiate_checkouts, f.add_to_carts),
    checkout_to_purchase_rate: rate(f.purchases, f.initiate_checkouts),
    lpv_to_atc_gap: Math.max(0, f.landing_page_views - f.add_to_carts),
    atc_to_checkout_gap: Math.max(0, f.add_to_carts - f.initiate_checkouts),
    checkout_to_purchase_gap: Math.max(0, f.initiate_checkouts - f.purchases),
  };
}

/** Zeroed meta rollup — the accumulator seed. */
function newMeta(): CreativeMetaMetrics {
  return {
    spend_cents: 0, impressions: 0, clicks: 0, ctr: 0,
    cpc_cents: 0, cpm_cents: 0, frequency: 0,
    purchases: 0, revenue_cents: 0, roas: 0, cpa_cents: null,
  };
}
function newFunnel(): CreativeFunnel {
  return { landing_page_views: 0, add_to_carts: 0, initiate_checkouts: 0, purchases: 0 };
}

/** Finalize a Meta accumulator: derive the rate metrics after all daily rows are summed. */
function finalizeMeta(m: CreativeMetaMetrics, freqSum: number, freqDays: number): CreativeMetaMetrics {
  const impressions = m.impressions;
  const clicks = m.clicks;
  const spend = m.spend_cents;
  const purchases = m.purchases;
  return {
    ...m,
    ctr: impressions > 0 ? round((clicks / impressions) * 100) : 0,
    cpc_cents: clicks > 0 ? Math.round(spend / clicks) : 0,
    cpm_cents: impressions > 0 ? Math.round((spend / impressions) * 1000) : 0,
    frequency: freqDays > 0 ? round(freqSum / freqDays) : 0,
    roas: spend > 0 ? round(m.revenue_cents / spend) : 0,
    cpa_cents: purchases > 0 ? Math.round(spend / purchases) : null,
  };
}

// ── Page past PostgREST's 1000-row cap ───────────────────────────────────────
async function fetchAllRows<T>(
  makeQuery: () => { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }> },
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1);
    if (error) break;
    const rows = data || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// ── The compute ──────────────────────────────────────────────────────────────

/**
 * Load the cross-cohort analytical scorecard for `[startIso, endIso]`.
 *
 * Read-only. Best-effort per source: a transient failure on one table returns an
 * empty rollup for that dimension rather than throwing (the caller sees a row with
 * a zero'd stage — the same fail-safe pattern the Phase-1/2 brief loaders use).
 */
export async function computeGrowthAnalyticalBrief(
  p: AnalyticalBriefParams,
): Promise<AnalyticalBriefResult> {
  const { admin, workspaceId, startIso, endIso } = p;
  const limit = Math.max(1, p.limit ?? MAX_ADS_IN_BRIEF);
  const wantedHandles = p.productHandles?.length
    ? new Set(p.productHandles.map((h) => h.toLowerCase()))
    : null;
  const startDate = startIso.slice(0, 10);
  const endDate = endIso.slice(0, 10);

  // 1) meta_insights_daily @ level='ad' — every ad with in-window spend/impressions.
  //    We roll to the meta_ad_id grain here; the Meta ad structure (adset/campaign parents,
  //    ad name) joins in below.
  const insightRows = await fetchAllRows<{
    meta_object_id: string;
    snapshot_date: string;
    spend_cents: number | null;
    impressions: number | null;
    clicks: number | null;
    purchases: number | null;
    revenue_cents: number | null;
    frequency: number | null;
    meta_ad_account_id: string;
  }>(() =>
    admin
      .from("meta_insights_daily")
      .select("meta_object_id, snapshot_date, spend_cents, impressions, clicks, purchases, revenue_cents, frequency, meta_ad_account_id")
      .eq("workspace_id", workspaceId)
      .eq("level", "ad")
      .gte("snapshot_date", startDate)
      .lte("snapshot_date", endDate)
      .order("meta_object_id", { ascending: true }),
  );

  interface MetaAcc { meta: CreativeMetaMetrics; freqSum: number; freqDays: number; }
  const metaByAd = new Map<string, MetaAcc>();
  for (const r of insightRows) {
    let acc = metaByAd.get(r.meta_object_id);
    if (!acc) { acc = { meta: newMeta(), freqSum: 0, freqDays: 0 }; metaByAd.set(r.meta_object_id, acc); }
    acc.meta.spend_cents += r.spend_cents ?? 0;
    acc.meta.impressions += r.impressions ?? 0;
    acc.meta.clicks += r.clicks ?? 0;
    acc.meta.purchases += r.purchases ?? 0;
    acc.meta.revenue_cents += r.revenue_cents ?? 0;
    if (r.frequency && r.frequency > 0) { acc.freqSum += r.frequency; acc.freqDays += 1; }
  }

  // Bail early if Meta insights are empty — return the empty shape rather than fabricate rows.
  const adIds = [...metaByAd.keys()];
  if (!adIds.length) {
    return { workspaceId, windowStartIso: startIso, windowEndIso: endIso, cohorts: [], rows: [], unresolvedAdIds: [] };
  }

  // 2) meta_ads — the ad's name + adset/campaign parents.
  const adMeta = new Map<string, { name: string | null; meta_adset_id: string | null; meta_campaign_id: string | null }>();
  {
    const rows = await fetchAllRows<{ meta_ad_id: string; name: string | null; meta_adset_id: string | null; meta_campaign_id: string | null }>(() =>
      admin
        .from("meta_ads")
        .select("meta_ad_id, name, meta_adset_id, meta_campaign_id")
        .eq("workspace_id", workspaceId)
        .in("meta_ad_id", adIds)
        .order("meta_ad_id", { ascending: true }),
    );
    for (const r of rows) adMeta.set(r.meta_ad_id, { name: r.name, meta_adset_id: r.meta_adset_id, meta_campaign_id: r.meta_campaign_id });
  }

  // 3) ad_publish_jobs — meta_ad_id → (destination_url, campaign_id). campaign_id → ad_campaigns.product_id.
  //    An ad is 1:1 with a publish job by meta_ad_id (workspace-scoped); take the most recent when
  //    Meta reused an id (rare — but keeps the join deterministic).
  const publishByAd = new Map<string, { destination_url: string | null; campaign_id: string }>();
  {
    const rows = await fetchAllRows<{ meta_ad_id: string | null; destination_url: string | null; campaign_id: string | null; created_at: string | null }>(() =>
      admin
        .from("ad_publish_jobs")
        .select("meta_ad_id, destination_url, campaign_id, created_at")
        .eq("workspace_id", workspaceId)
        .in("meta_ad_id", adIds)
        .order("meta_ad_id", { ascending: true }),
    );
    for (const r of rows) {
      if (!r.meta_ad_id || !r.campaign_id) continue;
      const prior = publishByAd.get(r.meta_ad_id);
      if (!prior || (r.created_at ?? "") > (prior as { created_at?: string }).created_at!) {
        publishByAd.set(r.meta_ad_id, { destination_url: r.destination_url, campaign_id: r.campaign_id });
      }
    }
  }

  // 4) ad_campaigns → products.handle — the COHORT resolution.
  const campaignToProduct = new Map<string, string>();
  const campaignIds = [...new Set([...publishByAd.values()].map((p) => p.campaign_id))];
  if (campaignIds.length) {
    const rows = await fetchAllRows<{ id: string; product_id: string | null }>(() =>
      admin.from("ad_campaigns").select("id, product_id").eq("workspace_id", workspaceId).in("id", campaignIds).order("id", { ascending: true }),
    );
    for (const r of rows) if (r.product_id) campaignToProduct.set(r.id, r.product_id);
  }
  const productIds = [...new Set(campaignToProduct.values())];
  const productMeta = new Map<string, { handle: string; title: string | null }>();
  if (productIds.length) {
    const rows = await fetchAllRows<{ id: string; handle: string | null; title: string | null }>(() =>
      admin.from("products").select("id, handle, title").eq("workspace_id", workspaceId).in("id", productIds).order("id", { ascending: true }),
    );
    for (const r of rows) if (r.handle) productMeta.set(r.id, { handle: r.handle, title: r.title });
  }

  // 5) On-site funnel per creative — sessions with utm_content=meta_ad_id + their events.
  //    Excludes internal customers, bots, and internal-flagged sessions (mirrors funnel-tree).
  const internalCustomerIds = await (async (): Promise<Set<string>> => {
    const { data } = await admin.from("customers").select("id").eq("workspace_id", workspaceId).eq("is_internal", true);
    return new Set(((data || []) as { id: string }[]).map((r) => r.id));
  })();

  const sessionRows = await fetchAllRows<{ id: string; utm_content: string | null; is_internal: boolean | null; is_bot: boolean | null; customer_id: string | null }>(() =>
    admin
      .from("storefront_sessions")
      .select("id, utm_content, is_internal, is_bot, customer_id")
      .eq("workspace_id", workspaceId)
      .in("utm_content", adIds)
      .gte("first_seen_at", startIso)
      .lte("first_seen_at", endIso)
      .order("id", { ascending: true }),
  );
  const sessionAd = new Map<string, string>();
  for (const s of sessionRows) {
    if (s.is_internal || s.is_bot) continue;
    if (s.customer_id && internalCustomerIds.has(s.customer_id)) continue;
    if (s.utm_content) sessionAd.set(s.id, s.utm_content);
  }

  const funnelByAd = new Map<string, CreativeFunnel>();
  for (const adId of adIds) funnelByAd.set(adId, newFunnel());
  if (sessionAd.size) {
    // Distinct-session counts per stage — a session that fires ATC twice still counts once.
    const seen: Record<keyof CreativeFunnel, Map<string, Set<string>>> = {
      landing_page_views: new Map(),
      add_to_carts: new Map(),
      initiate_checkouts: new Map(),
      purchases: new Map(),
    };
    const bump = (stage: keyof CreativeFunnel, adId: string, sessionId: string) => {
      let set = seen[stage].get(adId);
      if (!set) { set = new Set(); seen[stage].set(adId, set); }
      set.add(sessionId);
    };
    const events = await fetchAllRows<{ event_type: string; session_id: string }>(() =>
      admin
        .from("storefront_events")
        .select("event_type, session_id")
        .eq("workspace_id", workspaceId)
        .in("event_type", ["pdp_view", "add_to_cart", "checkout_view", "order_placed"])
        .gte("created_at", startIso)
        .lte("created_at", endIso)
        .order("id", { ascending: true }),
    );
    for (const e of events) {
      const adId = sessionAd.get(e.session_id);
      if (!adId) continue;
      const key: keyof CreativeFunnel | null =
        e.event_type === "pdp_view" ? "landing_page_views"
        : e.event_type === "add_to_cart" ? "add_to_carts"
        : e.event_type === "checkout_view" ? "initiate_checkouts"
        : e.event_type === "order_placed" ? "purchases"
        : null;
      if (key) bump(key, adId, e.session_id);
    }
    for (const adId of adIds) {
      const f = funnelByAd.get(adId)!;
      f.landing_page_views = seen.landing_page_views.get(adId)?.size ?? 0;
      f.add_to_carts = seen.add_to_carts.get(adId)?.size ?? 0;
      f.initiate_checkouts = seen.initiate_checkouts.get(adId)?.size ?? 0;
      f.purchases = seen.purchases.get(adId)?.size ?? 0;
    }
  }

  // 6) Per-variant ROAS — meta_attribution_daily @ ad grain.
  const variantsByAd = new Map<string, Map<string, VariantAttribution>>();
  {
    const rows = await fetchAllRows<{
      meta_ad_id: string; variant: string; snapshot_date: string;
      attributed_spend_cents: number | null; revenue_cents: number | null;
      sessions: number | null; orders: number | null;
    }>(() =>
      admin
        .from("meta_attribution_daily")
        .select("meta_ad_id, variant, snapshot_date, attributed_spend_cents, revenue_cents, sessions, orders")
        .eq("workspace_id", workspaceId)
        .in("meta_ad_id", adIds)
        .gte("snapshot_date", startDate)
        .lte("snapshot_date", endDate)
        .order("meta_ad_id", { ascending: true }),
    );
    for (const r of rows) {
      let m = variantsByAd.get(r.meta_ad_id);
      if (!m) { m = new Map(); variantsByAd.set(r.meta_ad_id, m); }
      let v = m.get(r.variant);
      if (!v) { v = { variant: r.variant, spend_cents: 0, revenue_cents: 0, roas: 0, sessions: 0, orders: 0 }; m.set(r.variant, v); }
      v.spend_cents += r.attributed_spend_cents ?? 0;
      v.revenue_cents += r.revenue_cents ?? 0;
      v.sessions += r.sessions ?? 0;
      v.orders += r.orders ?? 0;
    }
    for (const m of variantsByAd.values()) {
      for (const v of m.values()) v.roas = v.spend_cents > 0 ? round(v.revenue_cents / v.spend_cents) : 0;
    }
  }

  // 7) Materialize per-creative rows + cohort rollup.
  const rows: CreativeScorecardRow[] = [];
  const unresolvedAdIds: string[] = [];
  for (const adId of adIds) {
    const acc = metaByAd.get(adId)!;
    const meta = finalizeMeta(acc.meta, acc.freqSum, acc.freqDays);
    const ad = adMeta.get(adId);
    const publish = publishByAd.get(adId);
    const productId = publish ? campaignToProduct.get(publish.campaign_id) : undefined;
    const product = productId ? productMeta.get(productId) : undefined;
    const cohort = product?.handle ?? UNKNOWN_COHORT;
    const cohort_label = product?.title ?? product?.handle ?? "Unknown cohort";
    if (!product) unresolvedAdIds.push(adId);
    if (wantedHandles && !wantedHandles.has(cohort.toLowerCase())) continue;
    const funnel = funnelByAd.get(adId) ?? newFunnel();
    const variantMap = variantsByAd.get(adId);
    const variants = variantMap
      ? [...variantMap.values()].sort((a, b) => b.spend_cents - a.spend_cents)
      : [];
    rows.push({
      cohort,
      cohort_label,
      meta_ad_id: adId,
      meta_ad_name: ad?.name ?? null,
      meta_adset_id: ad?.meta_adset_id ?? null,
      meta_campaign_id: ad?.meta_campaign_id ?? null,
      destination_url: publish?.destination_url ?? null,
      meta,
      funnel,
      dropoffs: computeDropoffs(funnel),
      variants,
    });
  }

  // Sort by spend descending — the Director reads the biggest-spend rows first — then cap.
  rows.sort((a, b) => b.meta.spend_cents - a.meta.spend_cents);
  const capped = rows.slice(0, limit);

  const cohortAcc = new Map<string, { label: string; creatives: number; meta: CreativeMetaMetrics; freqSum: number; freqDays: number; funnel: CreativeFunnel }>();
  for (const r of capped) {
    let c = cohortAcc.get(r.cohort);
    if (!c) { c = { label: r.cohort_label, creatives: 0, meta: newMeta(), freqSum: 0, freqDays: 0, funnel: newFunnel() }; cohortAcc.set(r.cohort, c); }
    c.creatives += 1;
    c.meta.spend_cents += r.meta.spend_cents;
    c.meta.impressions += r.meta.impressions;
    c.meta.clicks += r.meta.clicks;
    c.meta.purchases += r.meta.purchases;
    c.meta.revenue_cents += r.meta.revenue_cents;
    if (r.meta.frequency > 0) { c.freqSum += r.meta.frequency; c.freqDays += 1; }
    c.funnel.landing_page_views += r.funnel.landing_page_views;
    c.funnel.add_to_carts += r.funnel.add_to_carts;
    c.funnel.initiate_checkouts += r.funnel.initiate_checkouts;
    c.funnel.purchases += r.funnel.purchases;
  }
  const cohorts: CohortSummary[] = [...cohortAcc.entries()].map(([cohort, c]) => ({
    cohort,
    cohort_label: c.label,
    creatives: c.creatives,
    totals: {
      ...finalizeMeta(c.meta, c.freqSum, c.freqDays),
      ...c.funnel,
    },
  })).sort((a, b) => b.totals.spend_cents - a.totals.spend_cents);

  return {
    workspaceId,
    windowStartIso: startIso,
    windowEndIso: endIso,
    cohorts,
    rows: capped,
    unresolvedAdIds,
  };
}

// Small utility re-exported so a caller can null-check derived rates the same way we do internally.
export { nullOr as _nullOr };
