/**
 * Slow-loop 4-month actual-LTV reconciler — Phase 3 of the storefront LTV-proxy
 * reconciler (docs/brain/specs/storefront-ltv-proxy-reconciler.md, M3).
 *
 * THE SUPERVISOR that catches the proxy lying ([[../operational-rules]] § North star).
 * The [[storefront-ltv-metrics|fast loop]] publishes `predicted_ltv_per_visitor` as the
 * reward the [[storefront-experiment-bandit-framework|M1 bandit]] decides on — but with
 * monthly renewals a cohort's TRUE LTV isn't known for ~4 months. This loop waits that
 * lag, then for each past cohort computes its ACTUAL realized margin-per-visitor from
 * orders/renewals ([[customer-stats]] `getCustomerStatsBatch`) and compares it to the
 * proxy recorded at decision time ([[storefront_ltv_metrics]]). The signed error:
 *
 *   • is persisted per cohort to [[storefront_ltv_reconciliations]] (proxy vs actual +
 *     error_pct + the dominant lever class — the M2 recalibration signal);
 *   • RECALIBRATES the proxy weights — a systematically over-predicting proxy (e.g.
 *     discount-heavy subs that churn) gets its est-sub-LTV down-weighted via the
 *     `sub_ltv_factor` the fast loop applies — and bumps the `weights_version`;
 *   • flips `calibrated=true` (writes `calibrated_at` to [[storefront_ltv_calibration]]),
 *     after which the bandit stops running conservatively;
 *   • a large persistent error is recorded with `escalated=true` + a structured ESCALATION
 *     log to the [[../functions/growth|Growth director]] — surfaced, never silently absorbed.
 *
 * IDEMPOTENT: a cohort reconciles exactly ONCE (unique cohort key); a re-run reconciles
 * only NEW cohorts and only those bump the weights_version. NO HARDCODED ECONOMICS: actual
 * LTV uses the same flagged margin fraction as the proxy until a real COGS source lands.
 *
 * The M2 lever-importance memory reads the reconciliation rows independently
 * ([[storefront-lever-memory]] `applyReconciliationSignal`) — cross-link, no hard
 * dependency: this loop just has to persist the signal.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getCustomerStatsBatch } from "@/lib/customer-stats";
import { INITIAL_WEIGHTS_VERSION, PLACEHOLDER_MARGIN_FRACTION } from "@/lib/storefront/ltv-proxy";
import { DEFAULT_WINDOW_DAYS } from "@/lib/storefront/ltv-metrics";

type Admin = ReturnType<typeof createAdminClient>;

/** The renewal lag before a cohort's actual LTV is meaningful (~4 months of monthly
 *  renewals). A cohort is reconciled only once its decision-time snapshot is this old. */
export const DEFAULT_RECONCILE_LAG_DAYS = 120;

/** Below this many converting customers the actual estimate is too noisy to recalibrate
 *  on or escalate — the row is still recorded (flagged), but excluded from the weight fit
 *  and from escalation. */
export const MIN_CONVERTERS_FOR_RECALIBRATION = 5;

/** |error_pct| at/above this on a sufficiently-sampled cohort escalates to Growth — the
 *  proxy lied by half its value, the supervisor surfaces it rather than absorbing it. */
export const ESCALATION_ERROR_PCT = 0.5;

/** Floor (cents) for the proxy denominator so a ~0 proxy doesn't explode error_pct. */
const PROXY_FLOOR_CENTS = 50;

/** Clamp the recalibration correction so one cohort batch can't whipsaw the weight. */
const FACTOR_MIN = 0.25;
const FACTOR_MAX = 4;

const PAGE = 1000;
const MAX_PAGES = 100;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function daysBetween(fromMs: number, toMs: number): number {
  return (toMs - fromMs) / (24 * 60 * 60 * 1000);
}

interface MetricRow {
  product_id: string;
  lander_type: string;
  audience: string;
  snapshot_date: string;
  predicted_ltv_per_visitor_cents: number;
  visitors: number;
  weights_version: number;
  margin_fraction: number;
}

export interface CohortReconciliation {
  product_id: string;
  lander_type: string;
  audience: string;
  cohort_snapshot_date: string;
  proxy_ltv_cents: number;
  actual_ltv_cents: number;
  error_pct: number;
  weights_version: number;
  lever_key: string | null;
  visitors: number;
  converting_customers: number;
  margin_fraction: number;
  escalated: boolean;
  flags: {
    /** Too few converting customers to recalibrate/escalate on (still recorded). */
    insufficient_actual_sample: boolean;
    /** Actual LTV reuses each customer's FULL realized history (getCustomerStatsBatch),
     *  not only cohort-attributed orders — the spec's sanctioned realized-orders source. */
    ltv_includes_full_customer_history: boolean;
  };
}

export interface ReconcileResult {
  workspace_id: string;
  /** Cohorts old enough to reconcile this run (excludes already-reconciled ones). */
  candidates: number;
  /** Newly reconciled cohorts persisted this run. */
  reconciled: CohortReconciliation[];
  /** Did a recalibration land (new reconciliations ⇒ weights_version bumped). */
  recalibrated: boolean;
  weights_version: number;
  sub_ltv_factor: number;
  calibrated_at: string | null;
  escalations: Array<{ cohort: string; error_pct: number; reason: string }>;
}

/** Page experiment_exposure for the workspace, returning the variant_id + first-exposure
 *  time per anonymous_id whose exposure landed on/before `asOfMs` and whose variant is in
 *  the cohort. A visitor exposed to several of the cohort's experiments counts once. */
async function firstExposuresForCohort(
  admin: Admin,
  workspaceId: string,
  variantIds: Set<string>,
  asOfMs: number,
): Promise<Map<string, number>> {
  const firstExposureByAnon = new Map<string, number>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await admin
      .from("storefront_events")
      .select("anonymous_id, meta, created_at")
      .eq("workspace_id", workspaceId)
      .eq("event_type", "experiment_exposure")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    const batch = (data as Array<{ anonymous_id: string | null; meta: Record<string, unknown>; created_at: string }>) || [];
    for (const row of batch) {
      const variantId = String(row.meta?.variant_id ?? "");
      if (!variantIds.has(variantId) || !row.anonymous_id) continue;
      const at = new Date(row.created_at).getTime();
      if (at > asOfMs) continue; // only visitors that existed at decision time
      const prev = firstExposureByAnon.get(row.anonymous_id);
      if (prev === undefined || at < prev) firstExposureByAnon.set(row.anonymous_id, at);
    }
    if (batch.length < PAGE) break;
    if (page === MAX_PAGES - 1) {
      console.warn(`[storefront-ltv-reconciler] experiment_exposure hit ${MAX_PAGES}-page cap for ws=${workspaceId}`);
    }
  }
  return firstExposureByAnon;
}

/**
 * Compute the ACTUAL realized margin-per-visitor for a cohort as of now: rebuild the
 * exposed visitors at decision time, attribute their first order within the
 * delayed-purchase window, resolve those orders to customers, and sum each customer's
 * full realized LTV ([[customer-stats]]) × the margin fraction, over the proxy's visitor
 * denominator. Pure read.
 */
async function actualCohortLtv(
  admin: Admin,
  workspaceId: string,
  cohort: MetricRow,
  variantIds: Set<string>,
  windowMs: number,
  marginFraction: number,
): Promise<{ actual_ltv_cents: number; converting_customers: number }> {
  // Visitors are anchored to the decision-time snapshot (end of that UTC day).
  const asOfMs = new Date(`${cohort.snapshot_date}T23:59:59.999Z`).getTime();
  const firstExposureByAnon = await firstExposuresForCohort(admin, workspaceId, variantIds, asOfMs);
  if (firstExposureByAnon.size === 0) return { actual_ltv_cents: 0, converting_customers: 0 };

  // First attributed order per visitor within the purchase window after first exposure.
  const anons = [...firstExposureByAnon.keys()];
  const firstOrderByAnon = new Map<string, { orderId: string; at: number }>();
  for (const ids of chunk(anons, 200)) {
    const { data } = await admin
      .from("storefront_events")
      .select("anonymous_id, meta, created_at")
      .eq("workspace_id", workspaceId)
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

  // Resolve attributed orders → the converting customers.
  const orderIds = [...new Set([...firstOrderByAnon.values()].map((o) => o.orderId))];
  const customerIds = new Set<string>();
  for (const ids of chunk(orderIds, 200)) {
    if (!ids.length) continue;
    const { data } = await admin.from("orders").select("id, customer_id").in("id", ids);
    for (const o of (data as Array<{ id: string; customer_id: string | null }> | null) ?? []) {
      if (o.customer_id) customerIds.add(o.customer_id);
    }
  }
  if (customerIds.size === 0) {
    // Visitors but no resolvable converting customer → actual realized margin is 0.
    return { actual_ltv_cents: 0, converting_customers: 0 };
  }

  // Realized lifetime revenue (incl. the ~4 months of renewals) of those customers.
  const stats = await getCustomerStatsBatch([...customerIds]);
  let realizedRevenueCents = 0;
  for (const s of stats.values()) realizedRevenueCents += s.ltv_cents;

  // Per-visitor MARGIN over the proxy's visitor denominator (apples-to-apples with the proxy).
  const denom = cohort.visitors > 0 ? cohort.visitors : firstExposureByAnon.size;
  const actual = denom > 0 ? Math.round((marginFraction * realizedRevenueCents) / denom) : 0;
  return { actual_ltv_cents: actual, converting_customers: customerIds.size };
}

/** The dominant lever class of a cohort's experiments (the M2 recalibration signal). */
async function dominantLever(
  admin: Admin,
  workspaceId: string,
  cohort: { product_id: string; lander_type: string; audience: string },
): Promise<{ leverKey: string | null; variantIds: Set<string> }> {
  const { data: experiments } = await admin
    .from("storefront_experiments")
    .select("id, lever")
    .eq("workspace_id", workspaceId)
    .eq("product_id", cohort.product_id)
    .eq("lander_type", cohort.lander_type)
    .eq("audience", cohort.audience);
  const exps = (experiments as Array<{ id: string; lever: string }> | null) ?? [];
  const counts = new Map<string, number>();
  for (const e of exps) counts.set(e.lever, (counts.get(e.lever) ?? 0) + 1);
  let leverKey: string | null = null;
  let best = 0;
  for (const [lever, n] of counts) if (n > best) ((best = n), (leverKey = lever));

  const variantIds = new Set<string>();
  const experimentIds = exps.map((e) => e.id);
  for (const ids of chunk(experimentIds, 200)) {
    if (!ids.length) continue;
    const { data } = await admin.from("storefront_experiment_variants").select("id").in("experiment_id", ids);
    for (const v of (data as Array<{ id: string }> | null) ?? []) variantIds.add(v.id);
  }
  return { leverKey, variantIds };
}

/**
 * Reconcile every past cohort whose decision-time proxy snapshot is now ≥ the renewal lag
 * old and that hasn't been reconciled yet. Records the proxy-vs-actual error, recalibrates
 * the proxy weights (bumping `weights_version` + correcting `sub_ltv_factor`), flips
 * `calibrated_at`, and escalates a large error. Idempotent — already-reconciled cohorts are
 * skipped and never re-bump the version.
 */
export async function reconcileLtvProxy(opts: {
  workspaceId: string;
  lagDays?: number;
  windowDays?: number;
  /** Override the placeholder margin fraction for actual LTV (mirrors the proxy). */
  marginFraction?: number;
  now?: Date;
  admin?: Admin;
}): Promise<ReconcileResult> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const lagDays = opts.lagDays ?? DEFAULT_RECONCILE_LAG_DAYS;
  const windowMs = (opts.windowDays ?? DEFAULT_WINDOW_DAYS) * 24 * 60 * 60 * 1000;
  const marginFraction = opts.marginFraction ?? PLACEHOLDER_MARGIN_FRACTION;

  // 1. Candidate cohorts = the EARLIEST metric snapshot per (product × lander × audience)
  //    — the proxy "recorded at decision time" — that is now ≥ lag old.
  const earliestByCohort = new Map<string, MetricRow>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await admin
      .from("storefront_ltv_metrics")
      .select("product_id, lander_type, audience, snapshot_date, predicted_ltv_per_visitor_cents, visitors, weights_version, margin_fraction")
      .eq("workspace_id", opts.workspaceId)
      .order("snapshot_date", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    const batch = (data as MetricRow[] | null) ?? [];
    for (const row of batch) {
      const key = `${row.product_id}|${row.lander_type}|${row.audience}`;
      if (!earliestByCohort.has(key)) earliestByCohort.set(key, row); // ascending ⇒ first seen is earliest
    }
    if (batch.length < PAGE) break;
  }

  // Already-reconciled cohort keys (idempotency: reconcile exactly once).
  const reconciledKeys = new Set<string>();
  {
    const { data } = await admin
      .from("storefront_ltv_reconciliations")
      .select("product_id, lander_type, audience, cohort_snapshot_date")
      .eq("workspace_id", opts.workspaceId);
    for (const r of (data as Array<{ product_id: string; lander_type: string; audience: string; cohort_snapshot_date: string }> | null) ?? []) {
      reconciledKeys.add(`${r.product_id}|${r.lander_type}|${r.audience}|${r.cohort_snapshot_date}`);
    }
  }

  const candidates: MetricRow[] = [];
  for (const row of earliestByCohort.values()) {
    const ageDays = daysBetween(new Date(`${row.snapshot_date}T00:00:00.000Z`).getTime(), nowMs);
    if (ageDays < lagDays) continue;
    const cohortKey = `${row.product_id}|${row.lander_type}|${row.audience}|${row.snapshot_date}`;
    if (reconciledKeys.has(cohortKey)) continue;
    candidates.push(row);
  }

  const reconciled: CohortReconciliation[] = [];
  const escalations: ReconcileResult["escalations"] = [];

  for (const cohort of candidates) {
    const { leverKey, variantIds } = await dominantLever(admin, opts.workspaceId, cohort);
    const { actual_ltv_cents, converting_customers } = await actualCohortLtv(
      admin,
      opts.workspaceId,
      cohort,
      variantIds,
      windowMs,
      marginFraction,
    );

    const proxy = cohort.predicted_ltv_per_visitor_cents;
    const errorPct = (actual_ltv_cents - proxy) / Math.max(proxy, PROXY_FLOOR_CENTS);
    const insufficient = converting_customers < MIN_CONVERTERS_FOR_RECALIBRATION;
    const escalated = !insufficient && Math.abs(errorPct) >= ESCALATION_ERROR_PCT;

    const rec: CohortReconciliation = {
      product_id: cohort.product_id,
      lander_type: cohort.lander_type,
      audience: cohort.audience,
      cohort_snapshot_date: cohort.snapshot_date,
      proxy_ltv_cents: proxy,
      actual_ltv_cents,
      error_pct: Math.round(errorPct * 1000) / 1000,
      weights_version: cohort.weights_version,
      lever_key: leverKey,
      visitors: cohort.visitors,
      converting_customers,
      margin_fraction: marginFraction,
      escalated,
      flags: {
        insufficient_actual_sample: insufficient,
        ltv_includes_full_customer_history: true,
      },
    };

    await admin.from("storefront_ltv_reconciliations").upsert(
      {
        workspace_id: opts.workspaceId,
        product_id: rec.product_id,
        lander_type: rec.lander_type,
        audience: rec.audience,
        cohort_snapshot_date: rec.cohort_snapshot_date,
        proxy_ltv_cents: rec.proxy_ltv_cents,
        actual_ltv_cents: rec.actual_ltv_cents,
        error_pct: rec.error_pct,
        weights_version: rec.weights_version,
        lever_key: rec.lever_key,
        visitors: rec.visitors,
        converting_customers: rec.converting_customers,
        margin_fraction: rec.margin_fraction,
        escalated: rec.escalated,
        flags: rec.flags,
        updated_at: now.toISOString(),
      },
      { onConflict: "workspace_id,product_id,lander_type,audience,cohort_snapshot_date" },
    );

    reconciled.push(rec);
    if (escalated) {
      const reason = `proxy-vs-actual error ${(rec.error_pct * 100).toFixed(0)}% (${
        rec.error_pct < 0 ? "over" : "under"
      }-predicted) on lever=${leverKey ?? "n/a"}`;
      escalations.push({ cohort: `${rec.product_id}|${rec.lander_type}|${rec.audience}`, error_pct: rec.error_pct, reason });
      // Surface, don't bury — escalate to Growth (durable row above + structured log).
      console.warn(
        `[storefront-ltv-reconciler] ESCALATION ws=${opts.workspaceId} cohort=${rec.product_id}/${rec.lander_type}/${rec.audience} ` +
          `proxy=${proxy} actual=${actual_ltv_cents} error_pct=${rec.error_pct} lever=${leverKey ?? "n/a"} → Growth director`,
      );
    }
  }

  // 2. Recalibrate the proxy weights from the visitor-weighted aggregate error across the
  //    sufficiently-sampled NEW reconciliations, then bump the version + flip calibrated.
  let recalibrated = false;
  let weightsVersion = INITIAL_WEIGHTS_VERSION;
  let subLtvFactor = 1;
  let calibratedAt: string | null = null;

  const { data: existingCal } = await admin
    .from("storefront_ltv_calibration")
    .select("weights_version, sub_ltv_factor, calibrated_at, reconciled_cohorts")
    .eq("workspace_id", opts.workspaceId)
    .maybeSingle();
  const cal = existingCal as
    | { weights_version: number; sub_ltv_factor: number; calibrated_at: string | null; reconciled_cohorts: number }
    | null;
  if (cal) {
    weightsVersion = cal.weights_version;
    subLtvFactor = cal.sub_ltv_factor;
    calibratedAt = cal.calibrated_at;
  }

  if (reconciled.length > 0) {
    // Visitor-weighted aggregate proxy + actual over sufficiently-sampled cohorts.
    let proxyWeighted = 0;
    let actualWeighted = 0;
    let aggErrorNum = 0;
    let aggErrorDen = 0;
    for (const r of reconciled) {
      if (r.flags.insufficient_actual_sample) continue;
      const w = Math.max(1, r.visitors);
      proxyWeighted += r.proxy_ltv_cents * w;
      actualWeighted += r.actual_ltv_cents * w;
      aggErrorNum += r.error_pct * w;
      aggErrorDen += w;
    }
    // Correction multiplier = actual / proxy (clamped), composed onto the prior factor so a
    // persistently over-predicting proxy keeps drifting its est-sub-LTV weight down.
    const ratio = proxyWeighted > 0 ? actualWeighted / proxyWeighted : 1;
    const correction = Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, ratio));
    const aggErrorPct = aggErrorDen > 0 ? aggErrorNum / aggErrorDen : 0;

    subLtvFactor = Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, subLtvFactor * correction));
    weightsVersion = weightsVersion + 1; // a recalibration landed ⇒ a new, auditable version
    calibratedAt = calibratedAt ?? now.toISOString(); // first reconciliation flips the gate
    recalibrated = true;

    await admin.from("storefront_ltv_calibration").upsert(
      {
        workspace_id: opts.workspaceId,
        calibrated_at: calibratedAt,
        weights_version: weightsVersion,
        sub_ltv_factor: Math.round(subLtvFactor * 1000) / 1000,
        last_error_pct: Math.round(aggErrorPct * 1000) / 1000,
        reconciled_cohorts: (cal?.reconciled_cohorts ?? 0) + reconciled.filter((r) => !r.flags.insufficient_actual_sample).length,
        updated_at: now.toISOString(),
      },
      { onConflict: "workspace_id" },
    );
  }

  console.log(
    `[storefront-ltv-reconciler] ws=${opts.workspaceId} candidates=${candidates.length} reconciled=${reconciled.length} ` +
      `recalibrated=${recalibrated} weights_version=${weightsVersion} sub_ltv_factor=${subLtvFactor} ` +
      `calibrated=${!!calibratedAt} escalations=${escalations.length}`,
  );

  return {
    workspace_id: opts.workspaceId,
    candidates: candidates.length,
    reconciled,
    recalibrated,
    weights_version: weightsVersion,
    sub_ltv_factor: Math.round(subLtvFactor * 1000) / 1000,
    calibrated_at: calibratedAt,
    escalations,
  };
}
