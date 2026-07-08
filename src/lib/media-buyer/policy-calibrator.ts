/**
 * media-buyer/policy-calibrator — pure per-cohort iteration_policies calibrator.
 *
 * Phase 1 of `media-buyer-per-cohort-iteration-policy-calibration` (goal
 * `autonomous-media-buyer-supervision`, M1 "Sensor trust"). Replaces the hardcoded
 * 1.5×/3.0× media-buyer seed with a data-derived per-cohort proposal minted from
 * each cohort's realized ROAS + spend distribution. Directly serves the goal's
 * "trustable thresholds" missing piece so shadow-mode calls are graded against
 * numbers the sensor actually justifies.
 *
 * Column contract (matches [[../../../docs/brain/tables/iteration_policies.md]] +
 * [[../../../docs/brain/libraries/iteration-policy-authoring.md]] `IterationPolicyDraft`
 * 1:1 — every non-id/non-status column). This module is PURE — no DB reads, no
 * clock reads, no fetches — so the Phase 2 runner is the only layer that touches
 * the workspace, and the calibrator is trivially unit-testable against fixtures.
 *
 * Rules (spec Phase 1 body):
 *   - `roas_floor` = clamp(median(roasSamples), 0.8, 2.0)
 *   - `scale_up_roas_trigger` = clamp(p75(roasSamples), roas_floor × 1.5, 5.0)
 *   - `pause_min_spend_cents` = p60(spendSamplesCents) clamped ≥ $50
 *   - `per_account_daily_budget_delta_ceiling_cents` = round(recentAccountSpendCents × 0.1)
 *     clamped ≥ $10
 *   - `scale_up_step_pct` + `scale_up_cap_pct` are NEVER re-proposed on the first
 *     calibration (carry-through from `currentPolicy` if provided, else seed). Same
 *     conservative posture as the hardcoded seed we're replacing — the calibrator
 *     tunes what the data supports, and leaves the pace knobs where the operator
 *     already had them.
 *   - Every other unmodeled knob (scale_down_step_pct, pause_window_days,
 *     unpause_*, min_creatives_per_adset, per_object_cooldown_hours,
 *     min_budget_floor_cents, never_pause_object_ids) carries through from
 *     `currentPolicy` if provided, else seed.
 *
 * Zero data ≡ category error, NOT a silent zero-policy — an empty `roasSamples`
 * throws `EmptyCalibrationSampleError`. The Phase 2 runner catches this and writes
 * a `director_activity` `media_buyer_calibration_deferred` row instead of authoring
 * a garbage policy version. Same north-star principle as the sensor-trust probe
 * (a red band ≡ escalate, not execute).
 */
import type { IterationPolicyDraft } from "@/lib/iteration-policy-authoring";

// ── Seed values (used when currentPolicy is absent) ──────────────────────────────
//
// These mirror the hardcoded 1.5×/3.0× seed the media-buyer's test fixtures and the
// current agent code reference. When we CAN'T back a knob with the cohort's data
// (empty spend samples, no recent account spend) we fall back to these — the
// calibrator NEVER emits an under-specified draft.

const SEED_ROAS_FLOOR = 1.5;
const SEED_SCALE_UP_ROAS_TRIGGER = 3.0;
const SEED_SCALE_UP_STEP_PCT = 0.15;
const SEED_SCALE_UP_CAP_PCT = 0.25;
const SEED_SCALE_DOWN_STEP_PCT = 0.2;
const SEED_PAUSE_MIN_SPEND_CENTS = 5_000; // $50
const SEED_PAUSE_WINDOW_DAYS = 7;
const SEED_UNPAUSE_SALES_AFTER_PAUSE = 0;
const SEED_UNPAUSE_LOOKBACK_DAYS = 14;
const SEED_MIN_CREATIVES_PER_ADSET = 0;
const SEED_PER_OBJECT_COOLDOWN_HOURS = 24;
const SEED_PER_ACCOUNT_DAILY_BUDGET_DELTA_CEILING_CENTS = 100_000; // $1000
const SEED_MIN_BUDGET_FLOOR_CENTS = 1_000;

// ── Clamp bounds (spec Phase 1 body) ─────────────────────────────────────────────

const ROAS_FLOOR_MIN = 0.8;
const ROAS_FLOOR_MAX = 2.0;
const SCALE_UP_TRIGGER_MAX = 5.0;
const SCALE_UP_TRIGGER_MULT_OF_FLOOR = 1.5; // trigger MUST be ≥ floor × 1.5
const PAUSE_MIN_SPEND_FLOOR_CENTS = 5_000; // $50
const DAILY_DELTA_CEILING_FLOOR_CENTS = 1_000; // $10
const DAILY_DELTA_CEILING_FRACTION_OF_SPEND = 0.1; // 10% of recent 7d spend

/** Thrown when the caller passes an empty roasSamples array — calibration on zero
 *  data is a category error the Phase 2 runner routes to a
 *  `media_buyer_calibration_deferred` director_activity row. */
export class EmptyCalibrationSampleError extends Error {
  constructor(message = "calibrateMediaBuyerPolicy: roasSamples is empty — calibration on zero data is a category error") {
    super(message);
    this.name = "EmptyCalibrationSampleError";
  }
}

export interface CalibrateMediaBuyerPolicyInput {
  /** Realized daily ROAS values (variant-level or account-level; the runner narrows
   *  by cohort). Must contain at least one finite value. */
  roasSamples: number[];
  /** Realized daily spend samples in cents (same window as roasSamples). May be
   *  empty — when it is we fall back to the seed pause_min_spend_cents. */
  spendSamplesCents: number[];
  /** Sum of recent (7d) account spend in cents. Drives the per-account daily-delta
   *  ceiling. Zero ⇒ ceiling pins to the $10 floor. */
  recentAccountSpendCents: number;
  /** The prior calibrated policy (or the current active policy) to carry the
   *  never-recalibrated knobs through from. Absent ⇒ seed. */
  currentPolicy?: Partial<IterationPolicyDraft> | null;
}

export interface CalibrateMediaBuyerPolicyResult {
  /** Ready to hand to `authorIterationPolicy` verbatim. */
  draft: IterationPolicyDraft;
  /** Human-legible rationale text citing every quantile the calibrator computed.
   *  The Phase 2 runner writes this to `iteration_policies.rationale` verbatim. */
  rationale: string;
  /** The intermediate quantiles the calibrator computed — surfaced so the runner
   *  (and its unit test) can assert against them without re-doing the math. */
  quantiles: {
    roasMedian: number;
    roasP75: number;
    spendP60Cents: number;
    sampleSize: number;
    spendSampleSize: number;
  };
}

/** Standard linear-interpolation quantile (matches numpy's `linear` and Excel's
 *  PERCENTILE). Sorts ascending. Caller MUST pass a non-empty array. */
function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) {
    throw new Error("quantile: empty array");
  }
  if (sortedAsc.length === 1) return sortedAsc[0];
  const clampedQ = Math.max(0, Math.min(1, q));
  const idx = clampedQ * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/** Pure per-cohort calibrator. Returns a fully-typed `IterationPolicyDraft` ready
 *  for `authorIterationPolicy`, plus the rationale text + the computed quantiles. */
export function calibrateMediaBuyerPolicy(
  input: CalibrateMediaBuyerPolicyInput,
): CalibrateMediaBuyerPolicyResult {
  const roas = input.roasSamples.filter((v) => Number.isFinite(v));
  if (roas.length === 0) {
    throw new EmptyCalibrationSampleError();
  }
  const spend = input.spendSamplesCents.filter((v) => Number.isFinite(v) && v >= 0);
  const recentAccountSpendCents = Math.max(0, Number(input.recentAccountSpendCents ?? 0));

  const roasSorted = [...roas].sort((a, b) => a - b);
  const spendSorted = [...spend].sort((a, b) => a - b);

  const roasMedian = quantile(roasSorted, 0.5);
  const roasP75 = quantile(roasSorted, 0.75);
  const spendP60Cents = spendSorted.length === 0 ? 0 : quantile(spendSorted, 0.6);

  // Round to 2dp — ROAS thresholds beyond that are meaningless, and rounding here
  // pins the calibrator's outputs to what the rationale text prints (toFixed(2))
  // so downstream equality tests aren't tripped by IEEE-754 noise (e.g. 0.8 * 1.5
  // = 1.2000000000000002).
  const roas_floor = round2(clamp(roasMedian, ROAS_FLOOR_MIN, ROAS_FLOOR_MAX));
  const scale_up_roas_trigger = round2(
    clamp(roasP75, roas_floor * SCALE_UP_TRIGGER_MULT_OF_FLOOR, SCALE_UP_TRIGGER_MAX),
  );

  // Empty spend samples ⇒ fall back to the seed floor ($50) — a cohort with no
  // realized spend samples has no evidence for a per-cohort pause threshold, so
  // the seed floor is the safe default.
  const pauseMinFromData = spendSorted.length === 0
    ? SEED_PAUSE_MIN_SPEND_CENTS
    : Math.max(PAUSE_MIN_SPEND_FLOOR_CENTS, Math.round(spendP60Cents));
  const pause_min_spend_cents = Math.max(PAUSE_MIN_SPEND_FLOOR_CENTS, pauseMinFromData);

  const per_account_daily_budget_delta_ceiling_cents = Math.max(
    DAILY_DELTA_CEILING_FLOOR_CENTS,
    Math.round(recentAccountSpendCents * DAILY_DELTA_CEILING_FRACTION_OF_SPEND),
  );

  // Carry-through knobs — the calibrator NEVER re-proposes these on the first pass
  // (spec Phase 1: "never propose scale_up_step_pct or scale_up_cap_pct changes on
  // the first calibration"). Same posture for the unmodeled operational knobs so
  // the draft is safe to hand straight to `authorIterationPolicy`.
  const prior = input.currentPolicy ?? {};
  const scale_up_step_pct = numberOr(prior.scale_up_step_pct, SEED_SCALE_UP_STEP_PCT);
  const scale_up_cap_pct = numberOr(prior.scale_up_cap_pct, SEED_SCALE_UP_CAP_PCT);
  const scale_down_step_pct = numberOr(prior.scale_down_step_pct, SEED_SCALE_DOWN_STEP_PCT);
  const pause_window_days = numberOr(prior.pause_window_days, SEED_PAUSE_WINDOW_DAYS);
  const unpause_sales_after_pause = numberOr(prior.unpause_sales_after_pause, SEED_UNPAUSE_SALES_AFTER_PAUSE);
  const unpause_lookback_days = numberOr(prior.unpause_lookback_days, SEED_UNPAUSE_LOOKBACK_DAYS);
  const min_creatives_per_adset = numberOr(prior.min_creatives_per_adset, SEED_MIN_CREATIVES_PER_ADSET);
  const per_object_cooldown_hours = numberOr(prior.per_object_cooldown_hours, SEED_PER_OBJECT_COOLDOWN_HOURS);
  const min_budget_floor_cents = prior.min_budget_floor_cents ?? SEED_MIN_BUDGET_FLOOR_CENTS;
  const never_pause_object_ids = prior.never_pause_object_ids ?? [];

  const draft: IterationPolicyDraft = {
    roas_floor,
    scale_up_roas_trigger,
    scale_up_step_pct,
    scale_up_cap_pct,
    scale_down_step_pct,
    pause_min_spend_cents,
    pause_window_days,
    unpause_sales_after_pause,
    unpause_lookback_days,
    min_creatives_per_adset,
    per_object_cooldown_hours,
    per_account_daily_budget_delta_ceiling_cents,
    min_budget_floor_cents,
    never_pause_object_ids,
  };

  const rationale =
    `Per-cohort calibration from ${roas.length} ROAS sample(s) + ${spend.length} spend sample(s). ` +
    `roas_floor=${roas_floor.toFixed(2)} = clamp(median(roas)=${roasMedian.toFixed(2)}, ${ROAS_FLOOR_MIN}, ${ROAS_FLOOR_MAX}); ` +
    `scale_up_roas_trigger=${scale_up_roas_trigger.toFixed(2)} = clamp(p75(roas)=${roasP75.toFixed(2)}, roas_floor×1.5=${(roas_floor * 1.5).toFixed(2)}, ${SCALE_UP_TRIGGER_MAX}); ` +
    `pause_min_spend_cents=${pause_min_spend_cents} = max($50, p60(spend)=${Math.round(spendP60Cents)}); ` +
    `per_account_daily_budget_delta_ceiling_cents=${per_account_daily_budget_delta_ceiling_cents} = max($10, 10% of recent 7d account spend $${(recentAccountSpendCents / 100).toFixed(2)}). ` +
    `scale_up_step_pct + scale_up_cap_pct carried from prior policy (never re-proposed on first calibration).`;

  return {
    draft,
    rationale,
    quantiles: {
      roasMedian,
      roasP75,
      spendP60Cents,
      sampleSize: roas.length,
      spendSampleSize: spend.length,
    },
  };
}

function numberOr(v: number | null | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
