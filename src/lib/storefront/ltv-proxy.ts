/**
 * Predicted-LTV proxy inputs — Phase 1 of the storefront LTV-proxy reconciler (M3,
 * docs/brain/specs/storefront-ltv-proxy-reconciler.md).
 *
 * The objective function for the storefront optimizer is
 * predicted-LTV-per-visitor — and because sub-LTV ≫ one-time, the proxy needs two
 * real-data inputs per cohort, both derived here:
 *   • `estimateSubLTV({ product_id, audience })` — the expected lifetime margin of a
 *     NEW subscriber for a product, derived from REALIZED subscription history:
 *     renewal survival (mean paid orders past the initial, off [[orders]].subscription_id
 *     — the universal source that covers Appstle + internal subs) × per-order charge,
 *     times a margin fraction.
 *   • `subAttachRate(cohort)` — subscription conversions ÷ converting sessions, off the
 *     append-only [[storefront_events]] `order_placed` stream joined to [[orders]] for
 *     subscription_id (the same attribution spine as
 *     [[storefront-experiment-attribution]]).
 *
 * NO HARDCODED ECONOMICS (the spec's safety invariant). There is no per-product COGS
 * source yet (the CFO COGS/landed-cost spine — ceo-mode M1 — isn't built), so the
 * margin fraction is a PARAMETER with a loud flag (`cogs_source_missing`), never a
 * silent economic truth. Likewise subscription history isn't audience-tagged yet, so
 * an `audience` argument is accepted but flagged `audience_not_segmentable` and the
 * estimate degrades to product-level — honest, not guessed.
 *
 * This phase ships the INPUT functions only. Phase 2 composes them into the
 * `predicted_ltv_per_visitor` metric and persists `storefront_ltv_metrics`; Phase 3
 * reconciles the proxy against actual 4-month cohort LTV and recalibrates the margin
 * weight recorded here.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getCustomerStatsBatch } from "@/lib/customer-stats";

type Admin = ReturnType<typeof createAdminClient>;

/** Placeholder gross-margin fraction applied to realized revenue when NO per-product
 *  COGS source exists. The CFO COGS/landed-cost spine isn't built, so margin can't be
 *  computed from real cost data. This is a PARAMETER with a loud flag — override via
 *  `opts.marginFraction` once a real COGS source lands. Phase 3's reconciler also
 *  recalibrates this weight against actual cohort LTV. */
export const PLACEHOLDER_MARGIN_FRACTION = 0.6;

/** Below this many realized subscribers the renewal-survival estimate is too noisy to
 *  trust; `estimateSubLTV` raises the `insufficient_history` flag (the caller — the M1
 *  bandit — should then lean conservative). */
export const MIN_SUBS_FOR_ESTIMATE = 5;

/** The proxy-weights version a metric row is computed under BEFORE the slow loop has
 *  recalibrated once. Every `storefront_ltv_metrics` row stamps the version it used so a
 *  recalibration is auditable and a past decision reproducible. Phase 3's reconciler
 *  bumps this off the proxy-vs-actual error and writes the new version to the
 *  `storefront_ltv_calibration` signal; until then it is the initial version. */
export const INITIAL_WEIGHTS_VERSION = 1;

/** Fully-refunded order statuses — excluded from realized revenue (mirrors
 *  [[customer-stats]] + [[storefront-experiment-attribution]]). */
const REFUNDED = new Set(["refunded", "REFUNDED", "partially_refunded", "PARTIALLY_REFUNDED"]);

const PAGE = 1000;
const MAX_PAGES = 100; // safety cap (100k rows) — logs if hit

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** A line inside subscriptions.items — internal subs key by product_id (UUID); Appstle
 *  subs may carry only Shopify variant ids and won't match by product_id (excluded +
 *  reflected in the sample size). */
function itemsMatchProduct(items: unknown, productId: string): boolean {
  if (!Array.isArray(items)) return false;
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (String(item.product_id ?? item.productId ?? "") === productId) return true;
  }
  return false;
}

export interface SubLTVEstimate {
  product_id: string;
  /** Echoed back; currently NOT used to segment (see `flags.audience_not_segmentable`). */
  audience: string | null;
  /** Mean paid orders PAST the initial per realized subscriber (renewal survival). */
  renewal_survival: number;
  /** Mean paid-order charge in cents across the sampled subs (gross). */
  mean_order_cents: number;
  /** Mean realized lifetime gross revenue per subscriber (initial + renewals). */
  mean_lifetime_revenue_cents: number;
  /** Margin fraction applied to gross revenue to get margin. */
  margin_fraction: number;
  /** The headline output: estimated lifetime MARGIN of a new subscriber, in cents. */
  est_sub_ltv_cents: number;
  /** Realized subscribers sampled (subs matching the product with ≥1 paid order). */
  sample_size: number;
  /** Cross-check: mean customer-level realized LTV of these subscribers, via
   *  [[customer-stats]] `getCustomerStatsBatch` (all their orders, not per-sub). */
  mean_subscriber_ltv_cents: number;
  flags: {
    /** No per-product COGS source — `margin_fraction` is the placeholder, not real cost. */
    cogs_source_missing: boolean;
    /** Subscription history isn't audience-tagged — estimate is product-level. */
    audience_not_segmentable: boolean;
    /** Sample below `MIN_SUBS_FOR_ESTIMATE` — treat the estimate as low-confidence. */
    insufficient_history: boolean;
  };
}

/**
 * Estimate the lifetime margin of a NEW subscriber for a product from realized
 * subscription history. Renewal survival comes from [[orders]].subscription_id (the
 * universal source covering Appstle + internal subs; [[transactions]] is Braintree-only
 * and misses Appstle renewals). Margin uses a flagged placeholder fraction until a real
 * COGS source exists.
 */
export async function estimateSubLTV(opts: {
  workspaceId: string;
  product_id: string;
  audience?: string | null;
  /** Override the placeholder margin fraction with a real per-product margin. */
  marginFraction?: number;
  admin?: Admin;
}): Promise<SubLTVEstimate> {
  const admin = opts.admin ?? createAdminClient();
  const audience = opts.audience ?? null;
  const marginFraction = opts.marginFraction ?? PLACEHOLDER_MARGIN_FRACTION;
  const cogsMissing = opts.marginFraction === undefined;

  const empty = (sample: number): SubLTVEstimate => ({
    product_id: opts.product_id,
    audience,
    renewal_survival: 0,
    mean_order_cents: 0,
    mean_lifetime_revenue_cents: 0,
    margin_fraction: marginFraction,
    est_sub_ltv_cents: 0,
    sample_size: sample,
    mean_subscriber_ltv_cents: 0,
    flags: {
      cogs_source_missing: cogsMissing,
      audience_not_segmentable: audience !== null,
      insufficient_history: sample < MIN_SUBS_FOR_ESTIMATE,
    },
  });

  // 1. Subscriptions for this product (scan items JSON in JS — robust across the
  //    internal {product_id} and Appstle item shapes; page like the rest of storefront/).
  const subIds: string[] = [];
  const customerIds = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await admin
      .from("subscriptions")
      .select("id, customer_id, items")
      .eq("workspace_id", opts.workspaceId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    const batch = (data as Array<{ id: string; customer_id: string | null; items: unknown }>) || [];
    for (const sub of batch) {
      if (!itemsMatchProduct(sub.items, opts.product_id)) continue;
      subIds.push(sub.id);
      if (sub.customer_id) customerIds.add(sub.customer_id);
    }
    if (batch.length < PAGE) break;
    if (page === MAX_PAGES - 1) {
      console.warn(`[storefront-ltv-proxy] subscriptions hit ${MAX_PAGES}-page cap for ws=${opts.workspaceId}`);
    }
  }
  if (subIds.length === 0) return empty(0);

  // 2. Paid orders per subscription (orders.subscription_id is the universal renewal log).
  const ordersBySub = new Map<string, number[]>(); // sub id → paid total_cents per order
  for (const ids of chunk(subIds, 200)) {
    const { data } = await admin
      .from("orders")
      .select("subscription_id, total_cents, financial_status")
      .in("subscription_id", ids);
    for (const o of (data as Array<{ subscription_id: string | null; total_cents: number | null; financial_status: string | null }>) || []) {
      if (!o.subscription_id) continue;
      if (o.financial_status && REFUNDED.has(o.financial_status)) continue;
      const arr = ordersBySub.get(o.subscription_id) ?? [];
      arr.push(o.total_cents ?? 0);
      ordersBySub.set(o.subscription_id, arr);
    }
  }

  // 3. Aggregate over realized subscribers (subs with ≥1 paid order). renewal survival =
  //    mean paid orders past the initial; lifetime revenue = mean total per subscriber.
  let totalRenewals = 0;
  let totalPaidOrders = 0;
  let totalRevenueCents = 0;
  let sampled = 0;
  for (const totals of ordersBySub.values()) {
    if (totals.length === 0) continue;
    sampled += 1;
    totalRenewals += totals.length - 1;
    totalPaidOrders += totals.length;
    totalRevenueCents += totals.reduce((a, b) => a + b, 0);
  }
  if (sampled === 0) return empty(subIds.length);

  const renewalSurvival = totalRenewals / sampled;
  const meanOrderCents = totalPaidOrders ? totalRevenueCents / totalPaidOrders : 0;
  const meanLifetimeRevenueCents = totalRevenueCents / sampled;
  const estSubLtvCents = Math.round(marginFraction * meanLifetimeRevenueCents);

  // 4. Cross-check input via getCustomerStatsBatch (spec: reuse for realized-orders).
  //    Customer-level LTV across ALL their orders — a sanity reference, not per-sub.
  let meanSubscriberLtvCents = 0;
  if (customerIds.size > 0) {
    const stats = await getCustomerStatsBatch([...customerIds]);
    let sum = 0;
    let n = 0;
    for (const s of stats.values()) {
      sum += s.ltv_cents;
      n += 1;
    }
    meanSubscriberLtvCents = n ? Math.round(sum / n) : 0;
  }

  const insufficient = sampled < MIN_SUBS_FOR_ESTIMATE;
  if (cogsMissing) {
    console.warn(
      `[storefront-ltv-proxy] no COGS source — estimateSubLTV using placeholder margin ${marginFraction} for product=${opts.product_id}`,
    );
  }
  if (insufficient) {
    console.warn(
      `[storefront-ltv-proxy] estimateSubLTV low confidence: only ${sampled} realized sub(s) for product=${opts.product_id}`,
    );
  }

  return {
    product_id: opts.product_id,
    audience,
    renewal_survival: renewalSurvival,
    mean_order_cents: Math.round(meanOrderCents),
    mean_lifetime_revenue_cents: Math.round(meanLifetimeRevenueCents),
    margin_fraction: marginFraction,
    est_sub_ltv_cents: estSubLtvCents,
    sample_size: sampled,
    mean_subscriber_ltv_cents: meanSubscriberLtvCents,
    flags: {
      cogs_source_missing: cogsMissing,
      audience_not_segmentable: audience !== null,
      insufficient_history: insufficient,
    },
  };
}

/** A cohort to measure sub-attach over. Sub-attach is keyed by product + time window
 *  here; `lander_type` / `audience` aren't yet filterable at event granularity (Phase 2
 *  ties them via experiment_exposure), so when supplied they're echoed + flagged, not
 *  applied. */
export interface SubAttachCohort {
  workspaceId: string;
  product_id: string;
  lander_type?: string | null;
  audience?: string | null;
  /** Window start (inclusive). Defaults to the beginning of the event log. */
  since?: Date | string;
  /** Window end (inclusive). Defaults to now. */
  until?: Date | string;
  admin?: Admin;
}

export interface SubAttachResult {
  product_id: string;
  lander_type: string | null;
  audience: string | null;
  /** Distinct sessions that placed an attributed order for the product. */
  converting_sessions: number;
  /** Of those, how many bought a subscription (order carried a subscription_id). */
  subscription_conversions: number;
  /** subscription_conversions ÷ converting_sessions (0 when no conversions). */
  sub_attach_rate: number;
  flags: {
    /** `lander_type` / `audience` weren't applied — not yet event-segmentable. */
    dims_not_segmentable: boolean;
  };
}

/**
 * Sub-attach rate for a cohort = subscription conversions ÷ converting sessions, off the
 * [[storefront_events]] `order_placed` stream joined to [[orders]] for subscription_id
 * (same attribution spine as [[storefront-experiment-attribution]]). A converting
 * session is counted once (its earliest order wins).
 */
export async function subAttachRate(cohort: SubAttachCohort): Promise<SubAttachResult> {
  const admin = cohort.admin ?? createAdminClient();
  const landerType = cohort.lander_type ?? null;
  const audience = cohort.audience ?? null;
  const sinceIso = cohort.since ? new Date(cohort.since).toISOString() : null;
  const untilIso = cohort.until ? new Date(cohort.until).toISOString() : null;

  // 1. order_placed events for the product within the window (product_id is denormalized
  //    on storefront_events for exactly this funnel query). One row per converting session.
  type SessionOrder = { orderId: string; at: number };
  const firstOrderBySession = new Map<string, SessionOrder>();
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = admin
      .from("storefront_events")
      .select("session_id, anonymous_id, meta, created_at")
      .eq("workspace_id", cohort.workspaceId)
      .eq("event_type", "order_placed")
      .eq("product_id", cohort.product_id)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (sinceIso) q = q.gte("created_at", sinceIso);
    if (untilIso) q = q.lte("created_at", untilIso);
    const { data } = await q;
    const batch =
      (data as Array<{ session_id: string | null; anonymous_id: string | null; meta: Record<string, unknown>; created_at: string }>) || [];
    for (const row of batch) {
      const sessionKey = row.session_id ?? row.anonymous_id;
      const orderId = String(row.meta?.order_id ?? "");
      if (!sessionKey || !orderId) continue;
      const at = new Date(row.created_at).getTime();
      const prev = firstOrderBySession.get(sessionKey);
      if (!prev || at < prev.at) firstOrderBySession.set(sessionKey, { orderId, at });
    }
    if (batch.length < PAGE) break;
    if (page === MAX_PAGES - 1) {
      console.warn(`[storefront-ltv-proxy] order_placed hit ${MAX_PAGES}-page cap for ws=${cohort.workspaceId}`);
    }
  }

  const convertingSessions = firstOrderBySession.size;
  if (convertingSessions === 0) {
    return {
      product_id: cohort.product_id,
      lander_type: landerType,
      audience,
      converting_sessions: 0,
      subscription_conversions: 0,
      sub_attach_rate: 0,
      flags: { dims_not_segmentable: landerType !== null || audience !== null },
    };
  }

  // 2. Which of those orders carried a subscription_id.
  const orderIds = [...new Set([...firstOrderBySession.values()].map((o) => o.orderId))];
  const subOrderIds = new Set<string>();
  for (const ids of chunk(orderIds, 200)) {
    const { data } = await admin.from("orders").select("id, subscription_id").in("id", ids);
    for (const o of (data as Array<{ id: string; subscription_id: string | null }>) || []) {
      if (o.subscription_id) subOrderIds.add(o.id);
    }
  }

  let subscriptionConversions = 0;
  for (const so of firstOrderBySession.values()) {
    if (subOrderIds.has(so.orderId)) subscriptionConversions += 1;
  }

  return {
    product_id: cohort.product_id,
    lander_type: landerType,
    audience,
    converting_sessions: convertingSessions,
    subscription_conversions: subscriptionConversions,
    sub_attach_rate: subscriptionConversions / convertingSessions,
    flags: { dims_not_segmentable: landerType !== null || audience !== null },
  };
}
