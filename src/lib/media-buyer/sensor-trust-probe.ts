/**
 * Media Buyer sensor-trust probe — media-buyer-sensor-trust-probe Phase 2.
 *
 * Per-workspace/per-account/per-day probe that reads the recalibrated attribution
 * rollup ([[../../tables/meta_attribution_daily]]) + insights rollup
 * ([[../../tables/meta_insights_daily]]) over a lookback window and emits ONE
 * `media_buyer_sensor_trust` row banded green/yellow/red so the Phase 3 short-
 * circuit can refuse to grade the Media Buyer's shadow-mode calls against
 * untrusted spend/revenue.
 *
 * Two exports:
 *   • `computeSensorTrust` — PURE (no DB, no I/O). Given rolled totals + the
 *     cohort thresholds, returns { band, reasons, metrics }. This is the seam
 *     the unit tests pin the band math against.
 *   • `runSensorTrustProbe` — orchestrator. Reads `meta_attribution_daily` +
 *     `meta_insights_daily` for `[today-14d, today-1d]` scoped to workspace +
 *     optional meta_ad_account_id, feeds them to `computeSensorTrust`, then
 *     UPSERTS the row on the composite unique
 *     `(workspace_id, coalesce(meta_ad_account_id::text,''), snapshot_date)`.
 *
 * Coverage semantics follow [[../../libraries/meta__attribution]] § Coverage shape:
 *   coverage_ratio          = resolved-revenue ÷ total-Meta-revenue (null if 0)
 *   unresolved_revenue_share = revenue on `(unresolved)` ÷ total-Meta-revenue
 *   spend_allocation_ratio   = attributed-spend ÷ total-Meta-insights-spend
 *
 * `(unresolved)` denominator semantics are per [[../../tables/meta_attribution_daily]]
 * § Gotchas — the sentinel row IS a real row and its revenue counts toward the
 * denominator of both coverage_ratio and unresolved_revenue_share.
 *
 * Realized-window pattern mirrors [[../../libraries/media-buyer-grader]] — the
 * probe reads a settled window ending yesterday (Central-time date bucket).
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** The `(unresolved)` variant sentinel — mirrors meta__attribution.UNRESOLVED_VARIANT. */
export const UNRESOLVED_VARIANT = "(unresolved)" as const;

/** Default lookback window (days) for the probe. Matches the spec's `[today-14d, today-1d]`
 *  — a wider window than meta__attribution's 7-day incremental so the sensor-trust signal
 *  averages over Meta's late attribution + first-touch backfill. */
export const DEFAULT_WINDOW_DAYS = 14;
/** Widest window Phase 2 lets a caller request. Mirrors media_buyer_sensor_trust check constraint. */
export const MAX_WINDOW_DAYS = 90;

/** Fallback band thresholds when the cohort row leaves a column null. */
export const DEFAULT_GREEN_MIN_COVERAGE = 0.7;
export const DEFAULT_YELLOW_MIN_COVERAGE = 0.5;
export const DEFAULT_MAX_UNRESOLVED_SHARE = 0.3;

/** Sample-size floor below which the probe emits `insufficient_sample` + band='red'. */
export const MIN_SAMPLE_ORDERS = 5;

/** Rolled totals the pure `computeSensorTrust` consumes. DB-free by construction. */
export interface SensorTrustTotals {
  /** Meta revenue attributed to a resolved (non-`(unresolved)`) variant, cents. */
  resolvedRevenueCents: number;
  /** Meta revenue attributed to `(unresolved)`, cents. */
  unresolvedRevenueCents: number;
  /** Attributed spend from meta_attribution_daily.attributed_spend_cents. */
  attributedSpendCents: number;
  /** Total insights-side spend for the window (meta_insights_daily, level='ad'). */
  totalSpendCents: number;
  /** Orders on resolved variants in the window (excludes `(unresolved)`). */
  resolvedOrders: number;
  /** Orders on `(unresolved)` in the window. */
  unresolvedOrders: number;
}

/** Owner-editable thresholds — read from media_buyer_test_cohorts (nullable → defaults). */
export interface SensorTrustThresholds {
  greenMinCoverage?: number | null;
  yellowMinCoverage?: number | null;
  maxUnresolvedShare?: number | null;
}

/** The typed verdict `computeSensorTrust` emits. */
export interface SensorTrustVerdict {
  band: "green" | "yellow" | "red";
  reasons: string[];
  coverageRatio: number | null;
  unresolvedRevenueShare: number | null;
  spendAllocationRatio: number | null;
  sampleOrders: number;
  sampleSpendCents: number;
}

/** Effective thresholds after defaults + coercion. Never NaN. */
interface EffectiveThresholds {
  greenMinCoverage: number;
  yellowMinCoverage: number;
  maxUnresolvedShare: number;
}

function coerceRatio(v: number | null | undefined, fallback: number): number {
  if (v == null) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function resolveThresholds(t: SensorTrustThresholds): EffectiveThresholds {
  const green = coerceRatio(t.greenMinCoverage, DEFAULT_GREEN_MIN_COVERAGE);
  let yellow = coerceRatio(t.yellowMinCoverage, DEFAULT_YELLOW_MIN_COVERAGE);
  // Guard: yellow floor MUST be ≤ green floor. A cohort authored with yellow > green would
  // paint every window red-or-green with no middle band — collapse yellow to green in that case.
  if (yellow > green) yellow = green;
  return {
    greenMinCoverage: green,
    yellowMinCoverage: yellow,
    maxUnresolvedShare: coerceRatio(t.maxUnresolvedShare, DEFAULT_MAX_UNRESOLVED_SHARE),
  };
}

/**
 * Pure sensor-trust scorer. No DB, no clocks — the same inputs produce the same
 * verdict every time so the unit tests can pin band math against fixture totals.
 *
 * Band semantics:
 *   red    = insufficient sample OR coverage below yellow floor OR unresolved share over cap
 *   yellow = coverage between yellow and green floors, unresolved share within cap
 *   green  = coverage at or above green floor, unresolved share within cap
 *
 * All three signals are ANDed together into the band — the WORST signal wins. This
 * matches the north-star rail: a single failing dimension is enough to demote trust.
 */
export function computeSensorTrust(
  totals: SensorTrustTotals,
  thresholds: SensorTrustThresholds,
): SensorTrustVerdict {
  const th = resolveThresholds(thresholds);

  const totalRevenueCents = totals.resolvedRevenueCents + totals.unresolvedRevenueCents;
  const totalOrders = totals.resolvedOrders + totals.unresolvedOrders;

  const coverageRatio = totalRevenueCents > 0
    ? Number((totals.resolvedRevenueCents / totalRevenueCents).toFixed(4))
    : null;
  const unresolvedRevenueShare = totalRevenueCents > 0
    ? Number((totals.unresolvedRevenueCents / totalRevenueCents).toFixed(4))
    : null;
  const spendAllocationRatio = totals.totalSpendCents > 0
    ? Number((totals.attributedSpendCents / totals.totalSpendCents).toFixed(4))
    : null;

  const reasons: string[] = [];
  let band: SensorTrustVerdict["band"] = "green";
  const worsenTo = (next: SensorTrustVerdict["band"]) => {
    // Order: green < yellow < red — never upgrade, only demote.
    if (next === "red") band = "red";
    else if (next === "yellow" && band !== "red") band = "yellow";
  };

  // ── Sample-thinness rail ───────────────────────────────────────────────────
  // The `MIN_SAMPLE_ORDERS` floor mirrors the grader — a window with two orders
  // is not evidence the sensor is clean. Zero-order windows are the special case
  // Phase 2's verification asserts explicitly (`sample_orders=0 + insufficient_sample`).
  if (totalOrders < MIN_SAMPLE_ORDERS) {
    reasons.push("insufficient_sample");
    worsenTo("red");
  }

  // ── Coverage rail — the core signal ────────────────────────────────────────
  if (coverageRatio == null) {
    // No Meta revenue in the window → no coverage signal to trust. Combined with
    // the sample rail above, this is virtually always already red; still note the
    // reason explicitly so the audit trail carries the shape.
    reasons.push("no_meta_revenue");
    worsenTo("red");
  } else if (coverageRatio < th.yellowMinCoverage) {
    reasons.push("low_coverage");
    worsenTo("red");
  } else if (coverageRatio < th.greenMinCoverage) {
    reasons.push("coverage_below_green");
    worsenTo("yellow");
  }

  // ── Unresolved-share rail — the complement axis ────────────────────────────
  if (unresolvedRevenueShare != null && unresolvedRevenueShare > th.maxUnresolvedShare) {
    reasons.push("unresolved_share_over_cap");
    worsenTo("red");
  }

  // ── Spend-allocation rail ──────────────────────────────────────────────────
  // A window where insights-side spend outstripped attributed spend by a wide
  // margin means the attribution layer starved (the meta-insights-ingest-empty-fix
  // shape). We degrade to YELLOW not RED — the coverage rail already carries the
  // dominant signal; this is a secondary observation the operator should see.
  if (spendAllocationRatio != null && spendAllocationRatio < th.yellowMinCoverage) {
    reasons.push("spend_allocation_thin");
    worsenTo("yellow");
  }

  return {
    band,
    reasons,
    coverageRatio,
    unresolvedRevenueShare,
    spendAllocationRatio,
    sampleOrders: totalOrders,
    sampleSpendCents: totals.totalSpendCents,
  };
}

/** Options for `runSensorTrustProbe`. */
export interface RunSensorTrustProbeArgs {
  workspaceId: string;
  /** null / undefined = workspace-wide snapshot; string = per-account snapshot. */
  metaAdAccountId?: string | null;
  /** Snapshot date (YYYY-MM-DD, Central-time bucket). Default = yesterday. */
  snapshotDate?: string;
  /** Lookback window in days. Default = DEFAULT_WINDOW_DAYS. */
  windowDays?: number;
  /** Injectable clock for tests. */
  nowMs?: number;
}

export interface RunSensorTrustProbeResult {
  snapshotDate: string;
  windowDays: number;
  band: SensorTrustVerdict["band"];
  reasons: string[];
  coverageRatio: number | null;
  unresolvedRevenueShare: number | null;
  spendAllocationRatio: number | null;
  sampleOrders: number;
  sampleSpendCents: number;
  /** True when the upsert wrote/updated exactly one row. */
  persisted: boolean;
}

/** Yesterday's YYYY-MM-DD (UTC-shifted to Central by the 5h offset the attribution lib uses).
 *  Simple offset — matches the storefront dashboards' bucketing without pulling a tz lib. */
function yesterdayCentralIso(nowMs: number): string {
  const d = new Date(nowMs);
  // 24h back for "yesterday", then 6h back to bias into Central-time day (approximation is
  // sufficient — the probe rolls to a whole day and the ±1d padding in meta__attribution
  // already handles the boundary).
  const shifted = new Date(d.getTime() - 24 * 3600_000 - 6 * 3600_000);
  return shifted.toISOString().slice(0, 10);
}

/** Read the effective thresholds for a workspace + optional account from media_buyer_test_cohorts. */
async function loadCohortThresholds(
  admin: Admin,
  workspaceId: string,
  metaAdAccountId: string | null,
): Promise<SensorTrustThresholds> {
  // Prefer per-account row over workspace-wide row (mirrors getEffectiveMediaBuyerTestCohort).
  const scoped = admin
    .from("media_buyer_test_cohorts")
    .select("green_min_coverage, yellow_min_coverage, max_unresolved_share, meta_ad_account_id")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);
  const { data, error } = metaAdAccountId
    ? await scoped.eq("meta_ad_account_id", metaAdAccountId).maybeSingle()
    : await scoped.is("meta_ad_account_id", null).maybeSingle();
  if (error || !data) return {};
  return {
    greenMinCoverage: (data as { green_min_coverage: number | null }).green_min_coverage,
    yellowMinCoverage: (data as { yellow_min_coverage: number | null }).yellow_min_coverage,
    maxUnresolvedShare: (data as { max_unresolved_share: number | null }).max_unresolved_share,
  };
}

interface AttributionRow {
  variant: string;
  attributed_spend_cents: number | string | null;
  revenue_cents: number | string | null;
  orders: number | string | null;
}

interface InsightsRow {
  spend_cents: number | string | null;
}

/**
 * Read attribution + insights over [snapshotDate - windowDays, snapshotDate] for a
 * workspace + optional account and roll them into `SensorTrustTotals`.
 */
async function rollTotals(
  admin: Admin,
  args: {
    workspaceId: string;
    metaAdAccountId: string | null;
    snapshotDate: string;
    windowDays: number;
  },
): Promise<SensorTrustTotals> {
  const endDate = args.snapshotDate;
  const startMs = new Date(endDate).getTime() - args.windowDays * 86400_000;
  const startDate = new Date(startMs).toISOString().slice(0, 10);

  let attributionQ = admin
    .from("meta_attribution_daily")
    .select("variant, attributed_spend_cents, revenue_cents, orders")
    .eq("workspace_id", args.workspaceId)
    .gte("snapshot_date", startDate)
    .lte("snapshot_date", endDate);
  if (args.metaAdAccountId) {
    attributionQ = attributionQ.eq("meta_ad_account_id", args.metaAdAccountId);
  }
  const { data: attRows } = await attributionQ;
  const attribution = (attRows || []) as AttributionRow[];

  let resolvedRevenueCents = 0;
  let unresolvedRevenueCents = 0;
  let attributedSpendCents = 0;
  let resolvedOrders = 0;
  let unresolvedOrders = 0;
  for (const r of attribution) {
    const rev = Number(r.revenue_cents ?? 0);
    const spend = Number(r.attributed_spend_cents ?? 0);
    const orders = Number(r.orders ?? 0);
    attributedSpendCents += spend;
    if (r.variant === UNRESOLVED_VARIANT) {
      unresolvedRevenueCents += rev;
      unresolvedOrders += orders;
    } else {
      resolvedRevenueCents += rev;
      resolvedOrders += orders;
    }
  }

  // Insights: level='ad' spend for the window scoped to the workspace + account.
  let insightsQ = admin
    .from("meta_insights_daily")
    .select("spend_cents")
    .eq("workspace_id", args.workspaceId)
    .eq("level", "ad")
    .gte("snapshot_date", startDate)
    .lte("snapshot_date", endDate);
  if (args.metaAdAccountId) {
    insightsQ = insightsQ.eq("meta_ad_account_id", args.metaAdAccountId);
  }
  const { data: insRows } = await insightsQ;
  const insights = (insRows || []) as InsightsRow[];
  let totalSpendCents = 0;
  for (const r of insights) totalSpendCents += Number(r.spend_cents ?? 0);

  return {
    resolvedRevenueCents,
    unresolvedRevenueCents,
    attributedSpendCents,
    totalSpendCents,
    resolvedOrders,
    unresolvedOrders,
  };
}

/**
 * The probe's chokepoint — reads attribution + insights, computes the verdict,
 * upserts one row on the composite unique key. Service-role only (RLS: the probe
 * runs from the box lane with admin credentials, not client-side).
 */
export async function runSensorTrustProbe(
  admin: Admin,
  args: RunSensorTrustProbeArgs,
): Promise<RunSensorTrustProbeResult> {
  const nowMs = args.nowMs ?? Date.now();
  const snapshotDate = args.snapshotDate ?? yesterdayCentralIso(nowMs);
  const rawWindow = args.windowDays ?? DEFAULT_WINDOW_DAYS;
  const windowDays = Math.max(1, Math.min(MAX_WINDOW_DAYS, Math.floor(rawWindow)));
  const metaAdAccountId = args.metaAdAccountId ?? null;

  const [thresholds, totals] = await Promise.all([
    loadCohortThresholds(admin, args.workspaceId, metaAdAccountId),
    rollTotals(admin, {
      workspaceId: args.workspaceId,
      metaAdAccountId,
      snapshotDate,
      windowDays,
    }),
  ]);

  const verdict = computeSensorTrust(totals, thresholds);

  const row = {
    workspace_id: args.workspaceId,
    meta_ad_account_id: metaAdAccountId,
    snapshot_date: snapshotDate,
    window_days: windowDays,
    coverage_ratio: verdict.coverageRatio,
    unresolved_revenue_share: verdict.unresolvedRevenueShare,
    spend_allocation_ratio: verdict.spendAllocationRatio,
    sample_orders: verdict.sampleOrders,
    sample_spend_cents: verdict.sampleSpendCents,
    band: verdict.band,
    reasons: verdict.reasons,
  };

  // The composite unique is an EXPRESSION index — `coalesce(meta_ad_account_id::text, '')`
  // — so Postgres can't accept it as an ON CONFLICT column list, and PostgREST/Supabase-js
  // can't pass expressions in `onConflict`. Do a manual select-then-write (compare-and-set):
  //   1) SELECT the row for (workspace, coalesce(account,''), date). At most one hit by the unique.
  //   2) If it exists → UPDATE by id (workspace-scoped) with `.select("id")` asserting exactly
  //      one row transitioned; otherwise INSERT with the same assertion.
  // The `.select("id")` on both writes catches a zero-row result (a concurrent probe stole
  // the slot) so the caller never mis-reports `persisted=true` on a no-op.
  let persisted = false;
  const selectQ = admin
    .from("media_buyer_sensor_trust")
    .select("id")
    .eq("workspace_id", args.workspaceId)
    .eq("snapshot_date", snapshotDate);
  const { data: existing } = metaAdAccountId
    ? await selectQ.eq("meta_ad_account_id", metaAdAccountId).maybeSingle()
    : await selectQ.is("meta_ad_account_id", null).maybeSingle();

  if (existing && (existing as { id: string }).id) {
    const id = (existing as { id: string }).id;
    const { data: updated, error: updErr } = await admin
      .from("media_buyer_sensor_trust")
      .update({
        window_days: row.window_days,
        coverage_ratio: row.coverage_ratio,
        unresolved_revenue_share: row.unresolved_revenue_share,
        spend_allocation_ratio: row.spend_allocation_ratio,
        sample_orders: row.sample_orders,
        sample_spend_cents: row.sample_spend_cents,
        band: row.band,
        reasons: row.reasons,
      })
      .eq("id", id)
      .eq("workspace_id", args.workspaceId)
      .select("id");
    persisted = !updErr && Array.isArray(updated) && updated.length === 1;
  } else {
    const { data: inserted, error: insErr } = await admin
      .from("media_buyer_sensor_trust")
      .insert(row)
      .select("id");
    persisted = !insErr && Array.isArray(inserted) && inserted.length === 1;
  }

  return {
    snapshotDate,
    windowDays,
    band: verdict.band,
    reasons: verdict.reasons,
    coverageRatio: verdict.coverageRatio,
    unresolvedRevenueShare: verdict.unresolvedRevenueShare,
    spendAllocationRatio: verdict.spendAllocationRatio,
    sampleOrders: verdict.sampleOrders,
    sampleSpendCents: verdict.sampleSpendCents,
    persisted,
  };
}
