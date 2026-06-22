/**
 * Predicted-LTV-per-visitor metric — Phase 2 of the storefront LTV-proxy reconciler
 * (docs/brain/specs/storefront-ltv-proxy-reconciler.md, M3).
 *
 * The FAST LOOP. This is the objective function the [[storefront-experiment-bandit-framework|M1 bandit]]
 * decides on — NOT raw CVR. Because sub-LTV ≫ one-time, a metric that values a
 * subscription conversion at its renewal-derived lifetime margin naturally teaches the
 * agent to turn visitors into subscribers, not just buyers:
 *
 *   predicted_ltv_per_visitor =
 *     ((one_time_conversions × one_time_margin) + (sub_conversions × est_sub_ltv)) ÷ visitors
 *
 * computed per `(product × lander_type × audience)` cohort over the M1 exposure→outcome
 * stream — `experiment_exposure` events (visitors) joined to `order_placed` + [[orders]]
 * (conversions / sub-attach / revenue), the same attribution spine as
 * [[storefront-experiment-attribution]]. The difference from the raw attribution proxy:
 * `est_sub_ltv` here is the Phase-1 renewal-derived [[storefront-ltv-proxy]] `estimateSubLTV`
 * (real subscription history), NOT the flat `EST_SUB_LTV_CENTS` placeholder the per-variant
 * rollup carries.
 *
 * Persisted into [[storefront_ltv_metrics]] (one row per cohort × snapshot_date),
 * UPSERTED on the snapshot key so a daily re-run never double-writes. Every row stamps the
 * `weights_version` it was computed under and a `calibrated` flag — false until M3's slow
 * loop (Phase 3) reconciles once, so the bandit runs conservatively until then.
 *
 * NO HARDCODED ECONOMICS (the spec's safety invariant): the margin fraction is the flagged
 * Phase-1 placeholder until a real per-product COGS source exists; the row carries the
 * fraction used + the `cogs_source_missing` flag.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { estimateSubLTV, INITIAL_WEIGHTS_VERSION, PLACEHOLDER_MARGIN_FRACTION, type SubLTVEstimate } from "@/lib/storefront/ltv-proxy";
import { getCalibrationState } from "@/lib/storefront/calibration";

type Admin = ReturnType<typeof createAdminClient>;

/** Default consider→buy lag (mirrors [[storefront-experiment-attribution]] DEFAULT_WINDOW_DAYS):
 *  an order attributes to a cohort if it lands within this many days of first exposure. */
export const DEFAULT_WINDOW_DAYS = 14;

/** Fully-refunded order statuses (mirrors [[storefront-ltv-proxy]] / attribution). Refunds are
 *  NOT subtracted from the proxy here — the M1 Phase-5 guardrail owns refund-spike rollback —
 *  so the metric stays consistent with the reward the bandit already optimizes. */
const REFUNDED = new Set(["refunded", "REFUNDED", "partially_refunded", "PARTIALLY_REFUNDED"]);

const PAGE = 1000;
const MAX_PAGES = 100; // safety cap (100k rows) — logs if hit

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface LtvPerVisitorCohort {
  workspaceId: string;
  product_id: string;
  lander_type: string;
  audience: string;
  /** Override the placeholder margin fraction with a real per-product margin. */
  marginFraction?: number;
  windowDays?: number;
  /** Snapshot reference time; the window is measured back from first exposure. Defaults to now. */
  now?: Date;
  /** Reuse a precomputed sub-LTV estimate (one estimateSubLTV call serves many cohorts of a product). */
  subLtv?: SubLTVEstimate;
  /** Phase-3 recalibration correction multiplied onto est_sub_ltv in the predicted sum
   *  (from [[storefront-calibration]] getCalibrationState). Defaults to 1 (uncalibrated). */
  subLtvFactor?: number;
  admin?: Admin;
}

export interface LtvPerVisitorResult {
  product_id: string;
  lander_type: string;
  audience: string;
  /** Distinct identities exposed to this cohort's experiments (the denominator). */
  visitors: number;
  /** Converting visitors whose attributed order was a one-time (non-subscription) purchase. */
  one_time_conversions: number;
  /** Converting visitors whose attributed order carried a subscription_id. */
  sub_conversions: number;
  /** sub_conversions ÷ converting sessions (0 when no conversions). */
  sub_attach_rate: number;
  /** Estimated lifetime MARGIN of a new subscriber (Phase-1 estimateSubLTV), in cents. */
  est_sub_ltv_cents: number;
  /** Mean MARGIN per one-time conversion = round(margin_fraction × mean one-time order revenue). */
  one_time_margin_cents: number;
  /** The headline reward: predicted lifetime margin per exposed visitor, in cents. */
  predicted_ltv_per_visitor_cents: number;
  margin_fraction: number;
  /** The Phase-3 est-sub-LTV recalibration correction applied in this row's predicted sum
   *  (1 until M3's slow loop reconciles once). */
  sub_ltv_factor: number;
  /** Realized subscribers sampled for the est_sub_ltv estimate. */
  est_sub_ltv_sample_size: number;
  flags: {
    /** No per-product COGS source — margin_fraction is the placeholder, not real cost. */
    cogs_source_missing: boolean;
    /** Subscription history isn't audience-tagged — est_sub_ltv is product-level. */
    audience_not_segmentable: boolean;
    /** Sub-LTV sample below the confidence floor — treat the estimate as low-confidence. */
    insufficient_sub_history: boolean;
    /** No exposed visitors in the window — the metric is empty for this snapshot. */
    no_exposures: boolean;
  };
}

/** Page experiment_exposure / order_placed events (1000-row windows, stable order). */
async function fetchEvents(
  admin: Admin,
  workspaceId: string,
  eventType: string,
  select: string,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await admin
      .from("storefront_events")
      .select(select)
      .eq("workspace_id", workspaceId)
      .eq("event_type", eventType)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    const batch = (data as unknown as Array<Record<string, unknown>>) || [];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    if (page === MAX_PAGES - 1) {
      console.warn(`[storefront-ltv-metrics] ${eventType} hit ${MAX_PAGES}-page cap for ws=${workspaceId}`);
    }
  }
  return rows;
}

/**
 * Compute the predicted-LTV-per-visitor metric for ONE `(product × lander_type × audience)`
 * cohort over the M1 exposure→outcome stream. Pure read; the caller persists the snapshot.
 */
export async function predictedLtvPerVisitor(cohort: LtvPerVisitorCohort): Promise<LtvPerVisitorResult> {
  const admin = cohort.admin ?? createAdminClient();
  const marginFraction = cohort.marginFraction ?? PLACEHOLDER_MARGIN_FRACTION;
  const cogsMissing = cohort.marginFraction === undefined;
  const windowMs = (cohort.windowDays ?? DEFAULT_WINDOW_DAYS) * 24 * 60 * 60 * 1000;
  const subLtvFactor = cohort.subLtvFactor ?? 1;

  // 1. Sub-LTV input (renewal-derived, product-level). Shared across cohorts of a product.
  const subLtv =
    cohort.subLtv ??
    (await estimateSubLTV({
      workspaceId: cohort.workspaceId,
      product_id: cohort.product_id,
      marginFraction: cohort.marginFraction,
      admin,
    }));

  const empty = (): LtvPerVisitorResult => ({
    product_id: cohort.product_id,
    lander_type: cohort.lander_type,
    audience: cohort.audience,
    visitors: 0,
    one_time_conversions: 0,
    sub_conversions: 0,
    sub_attach_rate: 0,
    est_sub_ltv_cents: subLtv.est_sub_ltv_cents,
    one_time_margin_cents: 0,
    predicted_ltv_per_visitor_cents: 0,
    margin_fraction: marginFraction,
    sub_ltv_factor: subLtvFactor,
    est_sub_ltv_sample_size: subLtv.sample_size,
    flags: {
      cogs_source_missing: cogsMissing,
      audience_not_segmentable: subLtv.flags.audience_not_segmentable,
      insufficient_sub_history: subLtv.flags.insufficient_history,
      no_exposures: true,
    },
  });

  // 2. The cohort's experiments (running|promoted — what's currently serving, matching
  //    the attribution spine) and their variant ids.
  const { data: experiments } = await admin
    .from("storefront_experiments")
    .select("id")
    .eq("workspace_id", cohort.workspaceId)
    .eq("product_id", cohort.product_id)
    .eq("lander_type", cohort.lander_type)
    .eq("audience", cohort.audience)
    .in("status", ["running", "promoted"]);
  const experimentIds = new Set((experiments as Array<{ id: string }> | null)?.map((e) => e.id) ?? []);
  if (experimentIds.size === 0) return empty();

  const variantIds = new Set<string>();
  for (const ids of chunk([...experimentIds], 200)) {
    const { data } = await admin
      .from("storefront_experiment_variants")
      .select("id")
      .in("experiment_id", ids);
    for (const v of (data as Array<{ id: string }> | null) ?? []) variantIds.add(v.id);
  }
  if (variantIds.size === 0) return empty();

  // 3. experiment_exposure → first-exposure time per identity across the cohort. A visitor
  //    exposed to several of the cohort's experiments is counted ONCE (earliest exposure).
  const firstExposureByAnon = new Map<string, number>(); // anonymous_id → ms
  for (const raw of await fetchEvents(admin, cohort.workspaceId, "experiment_exposure", "anonymous_id, meta, created_at")) {
    const row = raw as { anonymous_id: string | null; meta: Record<string, unknown>; created_at: string };
    const variantId = String(row.meta?.variant_id ?? "");
    if (!variantIds.has(variantId) || !row.anonymous_id) continue;
    const at = new Date(row.created_at).getTime();
    const prev = firstExposureByAnon.get(row.anonymous_id);
    if (prev === undefined || at < prev) firstExposureByAnon.set(row.anonymous_id, at);
  }

  const visitors = firstExposureByAnon.size;
  if (visitors === 0) return empty();

  // 4. order_placed for the exposed identities → earliest qualifying order per visitor
  //    within the delayed-purchase window after first exposure.
  const anons = [...firstExposureByAnon.keys()];
  type OrderEvent = { orderId: string; at: number };
  const firstOrderByAnon = new Map<string, OrderEvent>();
  for (const ids of chunk(anons, 200)) {
    const { data } = await admin
      .from("storefront_events")
      .select("anonymous_id, meta, created_at")
      .eq("workspace_id", cohort.workspaceId)
      .eq("event_type", "order_placed")
      .in("anonymous_id", ids);
    for (const row of (data as Array<{ anonymous_id: string | null; meta: Record<string, unknown>; created_at: string }> | null) ?? []) {
      const orderId = String(row.meta?.order_id ?? "");
      if (!row.anonymous_id || !orderId) continue;
      const firstExposed = firstExposureByAnon.get(row.anonymous_id);
      if (firstExposed === undefined) continue;
      const at = new Date(row.created_at).getTime();
      if (at < firstExposed || at - firstExposed > windowMs) continue;
      const prev = firstOrderByAnon.get(row.anonymous_id);
      if (!prev || at < prev.at) firstOrderByAnon.set(row.anonymous_id, { orderId, at });
    }
  }

  // 5. Resolve the attributed orders (authoritative revenue + subscription_id).
  const orderIds = [...new Set([...firstOrderByAnon.values()].map((o) => o.orderId))];
  const orderById = new Map<string, { total_cents: number; subscription_id: string | null; financial_status: string | null }>();
  for (const ids of chunk(orderIds, 200)) {
    if (!ids.length) continue;
    const { data } = await admin.from("orders").select("id, total_cents, subscription_id, financial_status").in("id", ids);
    for (const o of (data as Array<{ id: string; total_cents: number | null; subscription_id: string | null; financial_status: string | null }> | null) ?? []) {
      orderById.set(o.id, { total_cents: o.total_cents ?? 0, subscription_id: o.subscription_id, financial_status: o.financial_status });
    }
  }

  // 6. Split conversions one-time vs subscription; accumulate one-time revenue for the margin input.
  let oneTimeConversions = 0;
  let subConversions = 0;
  let oneTimeRevenueCents = 0;
  for (const { orderId } of firstOrderByAnon.values()) {
    const order = orderById.get(orderId);
    if (!order) continue;
    if (order.subscription_id) {
      subConversions += 1;
    } else {
      oneTimeConversions += 1;
      oneTimeRevenueCents += order.total_cents;
    }
  }

  const convertingSessions = oneTimeConversions + subConversions;
  const subAttachRateValue = convertingSessions > 0 ? subConversions / convertingSessions : 0;
  const oneTimeMarginCents = oneTimeConversions > 0 ? Math.round((marginFraction * oneTimeRevenueCents) / oneTimeConversions) : 0;
  // est_sub_ltv is the raw renewal-derived estimate; the predicted reward applies the
  // Phase-3 recalibration correction (down-weights a proxy the slow loop found over-predicts).
  const effectiveEstSubLtvCents = Math.round(subLtv.est_sub_ltv_cents * subLtvFactor);
  const predictedLtvPerVisitorCents = Math.round(
    (oneTimeConversions * oneTimeMarginCents + subConversions * effectiveEstSubLtvCents) / visitors,
  );

  return {
    product_id: cohort.product_id,
    lander_type: cohort.lander_type,
    audience: cohort.audience,
    visitors,
    one_time_conversions: oneTimeConversions,
    sub_conversions: subConversions,
    sub_attach_rate: subAttachRateValue,
    est_sub_ltv_cents: subLtv.est_sub_ltv_cents,
    one_time_margin_cents: oneTimeMarginCents,
    predicted_ltv_per_visitor_cents: predictedLtvPerVisitorCents,
    margin_fraction: marginFraction,
    sub_ltv_factor: subLtvFactor,
    est_sub_ltv_sample_size: subLtv.sample_size,
    flags: {
      cogs_source_missing: cogsMissing,
      audience_not_segmentable: subLtv.flags.audience_not_segmentable,
      insufficient_sub_history: subLtv.flags.insufficient_history,
      no_exposures: false,
    },
  };
}

export interface LtvMetricsRefreshResult {
  workspace_id: string;
  snapshot_date: string;
  cohorts: number;
  calibrated: boolean;
  weights_version: number;
  rows: LtvPerVisitorResult[];
}

/** UTC snapshot day (YYYY-MM-DD) — the upsert key dimension. */
function snapshotDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Daily fast-loop refresh for a workspace: compute predicted-LTV-per-visitor for every
 * active `(product × lander_type × audience)` cohort and UPSERT one
 * [[storefront_ltv_metrics]] row per cohort on the snapshot key (idempotent — a re-run for
 * the same day overwrites, never double-writes). Runs AFTER the M1 attribution rollup.
 */
export async function refreshLtvMetrics(opts: {
  workspaceId: string;
  windowDays?: number;
  marginFraction?: number;
  now?: Date;
}): Promise<LtvMetricsRefreshResult> {
  const admin = createAdminClient();
  const now = opts.now ?? new Date();
  const snapshot = snapshotDate(now);

  // Calibration signal (Phase 3 owns flipping it): the weights version to stamp, whether
  // the proxy has been reconciled once, and the est-sub-LTV recalibration correction.
  // Uncalibrated (factor 1) until then → bandit runs conservatively.
  const { calibrated, weights_version, sub_ltv_factor } = await getCalibrationState(opts.workspaceId);

  // Distinct active cohorts = (product × lander_type × audience) over running/promoted experiments.
  const { data: experiments } = await admin
    .from("storefront_experiments")
    .select("product_id, lander_type, audience")
    .eq("workspace_id", opts.workspaceId)
    .in("status", ["running", "promoted"]);
  const cohortKeys = new Map<string, { product_id: string; lander_type: string; audience: string }>();
  for (const e of (experiments as Array<{ product_id: string; lander_type: string; audience: string }> | null) ?? []) {
    cohortKeys.set(`${e.product_id}|${e.lander_type}|${e.audience}`, e);
  }
  if (cohortKeys.size === 0) {
    return { workspace_id: opts.workspaceId, snapshot_date: snapshot, cohorts: 0, calibrated, weights_version, rows: [] };
  }

  // One estimateSubLTV per product (shared across that product's cohorts).
  const subLtvByProduct = new Map<string, SubLTVEstimate>();
  const rows: LtvPerVisitorResult[] = [];
  for (const cohort of cohortKeys.values()) {
    let subLtv = subLtvByProduct.get(cohort.product_id);
    if (!subLtv) {
      subLtv = await estimateSubLTV({
        workspaceId: opts.workspaceId,
        product_id: cohort.product_id,
        marginFraction: opts.marginFraction,
        admin,
      });
      subLtvByProduct.set(cohort.product_id, subLtv);
    }

    const result = await predictedLtvPerVisitor({
      workspaceId: opts.workspaceId,
      product_id: cohort.product_id,
      lander_type: cohort.lander_type,
      audience: cohort.audience,
      marginFraction: opts.marginFraction,
      windowDays: opts.windowDays,
      now,
      subLtv,
      subLtvFactor: sub_ltv_factor,
      admin,
    });
    rows.push(result);

    await admin
      .from("storefront_ltv_metrics")
      .upsert(
        {
          workspace_id: opts.workspaceId,
          product_id: result.product_id,
          lander_type: result.lander_type,
          audience: result.audience,
          snapshot_date: snapshot,
          visitors: result.visitors,
          one_time_conversions: result.one_time_conversions,
          sub_conversions: result.sub_conversions,
          sub_attach_rate: result.sub_attach_rate,
          est_sub_ltv_cents: result.est_sub_ltv_cents,
          one_time_margin_cents: result.one_time_margin_cents,
          predicted_ltv_per_visitor_cents: result.predicted_ltv_per_visitor_cents,
          margin_fraction: result.margin_fraction,
          weights_version: weights_version ?? INITIAL_WEIGHTS_VERSION,
          calibrated,
          est_sub_ltv_sample_size: result.est_sub_ltv_sample_size,
          // sub_ltv_factor has no column — persisted in the flags jsonb so a recalibrated
          // row is auditable without a Phase-2 schema change.
          flags: { ...result.flags, sub_ltv_factor: result.sub_ltv_factor },
          updated_at: now.toISOString(),
        },
        { onConflict: "workspace_id,product_id,lander_type,audience,snapshot_date" },
      );
  }

  console.log(
    `[storefront-ltv-metrics] ws=${opts.workspaceId} snapshot=${snapshot} cohorts=${rows.length} ` +
      `calibrated=${calibrated} weights_version=${weights_version}`,
  );

  return { workspace_id: opts.workspaceId, snapshot_date: snapshot, cohorts: rows.length, calibrated, weights_version, rows };
}
