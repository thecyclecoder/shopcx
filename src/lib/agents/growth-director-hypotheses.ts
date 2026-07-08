/**
 * Growth Director hypothesis generation — Phase 2 (growth-director-analytical-brief spec).
 *
 * Pure, read-only reasoning over the Phase-1 [[./growth-director-analytical-brief]] scorecard.
 * The Director will run this in its Max box session, cite the returned hypotheses in its
 * verdict, and the WORKER (deterministic Node) is the only mutator — this module never writes
 * a DB row (spec § "Read-only reasoning; the worker persists").
 *
 * ── Hypothesis catalog (the 4 diagnostic reads the spec names) ───────────────
 *
 *   1. `funnel_not_creative` — a creative-vs-funnel SPLIT. The ad is doing its
 *      job (CTR above the healthy floor, real sessions arriving at the LPV) but
 *      the destination fails to carry them into a cart. Cited by the LPV→ATC
 *      cliff (`dropoffs.lpv_to_atc_rate` below floor with `landing_page_views`
 *      past the sample gate). The spec's live-read Tabs case + verification.
 *
 *   2. `format_effectiveness` — within a cohort, ONE variant's ROAS dramatically
 *      out- or under-performs the others. Per-product signal: "advertorial wins
 *      for Coffee, before/after loses for Tabs" is the flip Dylan noticed on the
 *      2026-07-08 live read. Requires ≥2 variants past the min-spend gate.
 *
 *   3. `delivery_anomaly` — CPM spike (above the ceiling), or frequency well past
 *      the fatigue threshold. The signal that the auction / audience-saturation
 *      side is the binding constraint, not the creative or the destination.
 *
 *   4. `audience_signal` — a cohort-wide low-CVR pattern across MULTIPLE
 *      creatives at spend — the traffic is wrong-intent, not the ads. Requires
 *      ≥2 creatives past the min-spend gate to fire (a single-creative CVR miss
 *      is a creative-level hypothesis, not an audience-level one).
 *
 * ── Min-spend / min-event gate (the media-buyer $450 verdict-floor discipline) ─
 * Every hypothesis is gated on the SAME rail the media-buyer uses to refuse
 * verdicts on tiny samples ([[../ads/winning-creative-detect]] `DEFAULT_MIN_SPEND_CENTS=$50`,
 * mirrored here). Below the floor a creative NEVER produces a call — instead
 * it lands on `belowFloor` with the specific gate that filtered it. The
 * verification's "small-sample cohort emits no call" case is exactly this.
 *
 *   Defaults (overridable per call via `opts.gate`):
 *     - min_spend_cents        = $50 (5_000 cents) — mirrors media-buyer
 *     - min_impressions        = 500 — for CTR-based reads
 *     - min_clicks             = 20  — for CTR/CPC-based reads
 *     - min_landing_page_views = 30  — for LPV/ATC-based reads
 *
 * ── Signal thresholds (`Signal*` consts) ─────────────────────────────────────
 * Every signal threshold has a NAMED constant so the returned evidence cites
 * both the observed value AND the floor it beat — the Director's verdict then
 * quotes real numbers, not a vibe.
 *
 * See [[../libraries/growth-director-analytical-brief]] · brain page
 * [[../libraries/growth-director-hypotheses]] · spec
 * `docs/brain/specs/growth-director-analytical-brief.md` § Phase 2.
 */
import type {
  AnalyticalBriefResult,
  CohortSummary,
  CreativeScorecardRow,
  VariantAttribution,
} from "./growth-director-analytical-brief";
import { UNKNOWN_COHORT } from "./growth-director-analytical-brief";

// ── Sample-gate defaults (media-buyer $450 verdict-floor discipline) ─────────
export const DEFAULT_MIN_SPEND_CENTS = 5_000; // $50 — same as ads/winning-creative-detect
export const DEFAULT_MIN_IMPRESSIONS = 500;
export const DEFAULT_MIN_CLICKS = 20;
export const DEFAULT_MIN_LANDING_PAGE_VIEWS = 30;

// ── Signal thresholds ───────────────────────────────────────────────────────
/** CTR at/above this (percent) reads as "the ad is doing its job" for the funnel-not-creative test. */
export const SIGNAL_HEALTHY_CTR_PCT = 1.0;
/** LPV→ATC rate BELOW this reads as a cliff — the destination isn't converting clicks into carts. */
export const SIGNAL_CLIFF_LPV_TO_ATC_RATE = 0.05;
/** A cohort-level CVR (order_placed / LPV) below this reads as the audience/traffic being wrong-intent. */
export const SIGNAL_LOW_COHORT_CVR = 0.01;
/** Top-variant ROAS must be at least this × the bottom-variant ROAS to call format-effectiveness. */
export const SIGNAL_FORMAT_ROAS_MULTIPLIER = 1.5;
/** Frequency (per-window mean) at/above this reads as fatigue delivery signal. */
export const SIGNAL_FATIGUE_FREQUENCY = 4.0;
/** CPM (dollars ×100 per 1k impressions) at/above this reads as an auction-side delivery anomaly. */
export const SIGNAL_HIGH_CPM_CENTS = 5_000; // $50 CPM

// ── Public shape ─────────────────────────────────────────────────────────────

/** The four diagnostic reads the spec names. */
export type HypothesisKind =
  | "funnel_not_creative"
  | "format_effectiveness"
  | "delivery_anomaly"
  | "audience_signal";

/** Confidence tier — `high` = well above every gate; `medium` = right at the floor.
 *  A creative below the floor NEVER emits a hypothesis (returns via `belowFloor`). */
export type HypothesisConfidence = "medium" | "high";

/** One piece of cited evidence — a name + the value/threshold pair the Director quotes. */
export interface HypothesisEvidence {
  /** e.g. `lpv_to_atc_rate`, `ctr`, `variant.roas` — the field or signal name. */
  field: string;
  /** The observed value (number or short string). */
  value: string | number;
  /** The floor / comparison threshold the value was checked against — omit for context-only fields. */
  threshold?: string | number;
}

export interface Hypothesis {
  kind: HypothesisKind;
  /** Product handle the hypothesis scopes to (matches [[./growth-director-analytical-brief]] cohort). */
  cohort: string;
  cohort_label: string;
  /** Per-creative hypotheses (`funnel_not_creative`, `delivery_anomaly`) carry the specific ad id.
   *  Cohort-level hypotheses (`format_effectiveness`, `audience_signal`) omit it. */
  meta_ad_id?: string;
  /** Human-readable title, e.g. `Tabs Advertorial: LPV→ATC cliff (2% ATC on 412 LPV)`. */
  title: string;
  /** One-line why — the diagnosis the Director will read into its verdict. */
  summary: string;
  evidence: HypothesisEvidence[];
  confidence: HypothesisConfidence;
}

/** A creative or cohort dropped by the sample gate — carries the SPECIFIC gate that filtered it. */
export interface BelowFloorEntry {
  cohort: string;
  cohort_label: string;
  /** Present when the entry is a creative (funnel-level gate); omitted for cohort-level gates. */
  meta_ad_id?: string;
  reason: string;
}

export interface HypothesesResult {
  hypotheses: Hypothesis[];
  belowFloor: BelowFloorEntry[];
  /** The gate the pass ran under — echoed so the Director's brief cites the ACTUAL floor. */
  gate: SampleGate;
}

export interface SampleGate {
  min_spend_cents: number;
  min_impressions: number;
  min_clicks: number;
  min_landing_page_views: number;
}

export interface GenerateHypothesesOptions {
  /** Override the per-signal sample gate. Any missing field defaults to the media-buyer floor. */
  gate?: Partial<SampleGate>;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function resolveGate(g?: Partial<SampleGate>): SampleGate {
  return {
    min_spend_cents: g?.min_spend_cents ?? DEFAULT_MIN_SPEND_CENTS,
    min_impressions: g?.min_impressions ?? DEFAULT_MIN_IMPRESSIONS,
    min_clicks: g?.min_clicks ?? DEFAULT_MIN_CLICKS,
    min_landing_page_views: g?.min_landing_page_views ?? DEFAULT_MIN_LANDING_PAGE_VIEWS,
  };
}

/** Cell above the gate along the axes needed for a per-creative funnel read. */
function passesFunnelGate(row: CreativeScorecardRow, gate: SampleGate): boolean {
  return (
    row.meta.spend_cents >= gate.min_spend_cents &&
    row.meta.impressions >= gate.min_impressions &&
    row.funnel.landing_page_views >= gate.min_landing_page_views
  );
}

/** Cell above the gate along the axes needed for a per-creative delivery read. */
function passesDeliveryGate(row: CreativeScorecardRow, gate: SampleGate): boolean {
  return (
    row.meta.spend_cents >= gate.min_spend_cents &&
    row.meta.impressions >= gate.min_impressions
  );
}

/** Cohort totals above the gate along the axes needed for a cohort-level format read. */
function cohortPassesFormatGate(cohort: CohortSummary, gate: SampleGate): boolean {
  return cohort.totals.spend_cents >= gate.min_spend_cents;
}

/** Confidence tier — `high` when EVERY relevant metric is ≥ 3× its floor, else `medium`. */
function confidenceFor(above: boolean[]): HypothesisConfidence {
  return above.every(Boolean) ? "high" : "medium";
}

/** ×100-safe rounding for evidence display. */
const round = (n: number, p = 4): number => Number(n.toFixed(p));

// ── Generators ──────────────────────────────────────────────────────────────

/**
 * Funnel-not-creative — the SPEC'S live-read case. Emits when the ad clears the healthy-CTR
 * floor AND real LPV traffic arrives AND the LPV→ATC transition falls below the cliff floor.
 *
 * The `funnel/destination suspect` diagnosis the Director then reads into its verdict.
 */
function funnelNotCreativeFor(row: CreativeScorecardRow, gate: SampleGate): Hypothesis | null {
  const rate = row.dropoffs.lpv_to_atc_rate;
  if (rate == null) return null;
  if (rate >= SIGNAL_CLIFF_LPV_TO_ATC_RATE) return null;
  if (row.meta.ctr < SIGNAL_HEALTHY_CTR_PCT) return null;

  const conf = confidenceFor([
    row.meta.spend_cents >= 3 * gate.min_spend_cents,
    row.funnel.landing_page_views >= 3 * gate.min_landing_page_views,
    row.meta.ctr >= 1.5 * SIGNAL_HEALTHY_CTR_PCT,
  ]);

  return {
    kind: "funnel_not_creative",
    cohort: row.cohort,
    cohort_label: row.cohort_label,
    meta_ad_id: row.meta_ad_id,
    title: `${row.cohort_label}: LPV→ATC cliff (${(rate * 100).toFixed(1)}% on ${row.funnel.landing_page_views} LPV)`,
    summary: `Creative is doing its job (CTR ${row.meta.ctr.toFixed(2)}% ≥ healthy ${SIGNAL_HEALTHY_CTR_PCT}%) but the destination fails to carry clicks into carts — funnel / destination suspect.`,
    evidence: [
      { field: "ctr", value: round(row.meta.ctr, 2), threshold: SIGNAL_HEALTHY_CTR_PCT },
      { field: "landing_page_views", value: row.funnel.landing_page_views, threshold: gate.min_landing_page_views },
      { field: "add_to_carts", value: row.funnel.add_to_carts },
      { field: "lpv_to_atc_rate", value: round(rate, 4), threshold: SIGNAL_CLIFF_LPV_TO_ATC_RATE },
      { field: "lpv_to_atc_gap", value: row.dropoffs.lpv_to_atc_gap },
      { field: "spend_cents", value: row.meta.spend_cents, threshold: gate.min_spend_cents },
    ],
    confidence: conf,
  };
}

/**
 * Delivery anomaly — CPM spike or frequency past the fatigue floor. Per-creative signal;
 * emits only when the ad clears the delivery gate (spend + impressions past floor).
 */
function deliveryAnomalyFor(row: CreativeScorecardRow, gate: SampleGate): Hypothesis | null {
  const cpmHigh = row.meta.cpm_cents >= SIGNAL_HIGH_CPM_CENTS;
  const freqHigh = row.meta.frequency >= SIGNAL_FATIGUE_FREQUENCY;
  if (!cpmHigh && !freqHigh) return null;

  const conf = confidenceFor([
    row.meta.spend_cents >= 3 * gate.min_spend_cents,
    row.meta.impressions >= 3 * gate.min_impressions,
    cpmHigh && row.meta.cpm_cents >= 1.5 * SIGNAL_HIGH_CPM_CENTS,
  ]);

  const kindLabel = cpmHigh && freqHigh ? "CPM spike + fatigue" : cpmHigh ? "CPM spike" : "audience fatigue";
  return {
    kind: "delivery_anomaly",
    cohort: row.cohort,
    cohort_label: row.cohort_label,
    meta_ad_id: row.meta_ad_id,
    title: `${row.cohort_label}: ${kindLabel} on ad ${row.meta_ad_id}`,
    summary: `Delivery-side signal — CPM $${(row.meta.cpm_cents / 100).toFixed(2)}${freqHigh ? `, frequency ${row.meta.frequency.toFixed(2)}` : ""}. Auction / audience saturation is the binding constraint, not the creative.`,
    evidence: [
      cpmHigh
        ? { field: "cpm_cents", value: row.meta.cpm_cents, threshold: SIGNAL_HIGH_CPM_CENTS }
        : { field: "cpm_cents", value: row.meta.cpm_cents },
      freqHigh
        ? { field: "frequency", value: round(row.meta.frequency, 2), threshold: SIGNAL_FATIGUE_FREQUENCY }
        : { field: "frequency", value: round(row.meta.frequency, 2) },
      { field: "impressions", value: row.meta.impressions, threshold: gate.min_impressions },
      { field: "spend_cents", value: row.meta.spend_cents, threshold: gate.min_spend_cents },
    ],
    confidence: conf,
  };
}

/**
 * Format-effectiveness-by-product — for a cohort with ≥2 variants past the min-spend gate,
 * emits when the top-ROAS variant beats the bottom-ROAS variant by ≥ `SIGNAL_FORMAT_ROAS_MULTIPLIER`.
 * The `(unresolved)` bucket is skipped (it's the attribution-miss sentinel, not a real format).
 */
function formatEffectivenessFor(
  cohort: CohortSummary,
  rows: CreativeScorecardRow[],
  gate: SampleGate,
): Hypothesis | null {
  // Roll variants across every row in the cohort so the read isn't per-creative noise.
  const acc = new Map<string, { spend: number; revenue: number; sessions: number; orders: number }>();
  for (const r of rows) {
    if (r.cohort !== cohort.cohort) continue;
    for (const v of r.variants) {
      if (v.variant === "(unresolved)") continue;
      let a = acc.get(v.variant);
      if (!a) { a = { spend: 0, revenue: 0, sessions: 0, orders: 0 }; acc.set(v.variant, a); }
      a.spend += v.spend_cents;
      a.revenue += v.revenue_cents;
      a.sessions += v.sessions;
      a.orders += v.orders;
    }
  }
  const qualified = [...acc.entries()]
    .filter(([, a]) => a.spend >= gate.min_spend_cents)
    .map(([variant, a]) => ({ variant, spend: a.spend, revenue: a.revenue, roas: a.spend > 0 ? a.revenue / a.spend : 0 }));
  if (qualified.length < 2) return null;
  qualified.sort((a, b) => b.roas - a.roas);
  const top = qualified[0];
  const bot = qualified[qualified.length - 1];
  if (bot.roas <= 0) {
    // Bottom variant has zero ROAS — the multiplier compare degenerates; use an absolute-gap signal instead.
    if (top.roas < 1.0) return null;
  } else if (top.roas < bot.roas * SIGNAL_FORMAT_ROAS_MULTIPLIER) {
    return null;
  }

  const conf = confidenceFor([
    top.spend >= 3 * gate.min_spend_cents,
    bot.spend >= 3 * gate.min_spend_cents,
    top.roas >= (bot.roas || 0.01) * 2,
  ]);

  return {
    kind: "format_effectiveness",
    cohort: cohort.cohort,
    cohort_label: cohort.cohort_label,
    title: `${cohort.cohort_label}: ${top.variant} wins vs ${bot.variant} (ROAS ${top.roas.toFixed(2)} vs ${bot.roas.toFixed(2)})`,
    summary: `Within-cohort format signal — ${top.variant} ROAS ${top.roas.toFixed(2)} × on $${(top.spend / 100).toFixed(2)} vs ${bot.variant} ROAS ${bot.roas.toFixed(2)} × on $${(bot.spend / 100).toFixed(2)}. Format matters for this product; propose a matched-lander test on ${top.variant}.`,
    evidence: [
      { field: "top_variant", value: top.variant },
      { field: "top_variant.roas", value: round(top.roas, 2) },
      { field: "top_variant.spend_cents", value: top.spend, threshold: gate.min_spend_cents },
      { field: "bottom_variant", value: bot.variant },
      { field: "bottom_variant.roas", value: round(bot.roas, 2) },
      { field: "bottom_variant.spend_cents", value: bot.spend, threshold: gate.min_spend_cents },
      { field: "format_roas_multiplier", value: round(top.roas / (bot.roas || 0.01), 2), threshold: SIGNAL_FORMAT_ROAS_MULTIPLIER },
    ],
    confidence: conf,
  };
}

/**
 * Audience-signal — cohort-wide low-CVR across ≥2 creatives past the min-spend gate. The traffic
 * is arriving but nobody converts — the audience is wrong-intent, not the ads. This is the
 * ONE cohort-wide read the spec names.
 */
function audienceSignalFor(
  cohort: CohortSummary,
  rows: CreativeScorecardRow[],
  gate: SampleGate,
): Hypothesis | null {
  const qualified = rows.filter((r) => r.cohort === cohort.cohort && passesFunnelGate(r, gate));
  if (qualified.length < 2) return null;
  const totalLpv = qualified.reduce((s, r) => s + r.funnel.landing_page_views, 0);
  const totalPurchases = qualified.reduce((s, r) => s + r.funnel.purchases, 0);
  const cvr = totalLpv > 0 ? totalPurchases / totalLpv : 0;
  if (cvr >= SIGNAL_LOW_COHORT_CVR) return null;
  // We need the CTR to be healthy — if CTR is also low, the creatives are the story, not the audience.
  const meanCtr = qualified.reduce((s, r) => s + r.meta.ctr, 0) / qualified.length;
  if (meanCtr < SIGNAL_HEALTHY_CTR_PCT) return null;

  const conf = confidenceFor([
    cohort.totals.spend_cents >= 3 * gate.min_spend_cents,
    qualified.length >= 3,
    cvr < SIGNAL_LOW_COHORT_CVR / 2,
  ]);

  return {
    kind: "audience_signal",
    cohort: cohort.cohort,
    cohort_label: cohort.cohort_label,
    title: `${cohort.cohort_label}: cohort-wide low CVR across ${qualified.length} creatives (${(cvr * 100).toFixed(2)}% on ${totalLpv} LPV)`,
    summary: `Every qualifying ad delivers healthy CTR (mean ${meanCtr.toFixed(2)}%) but the cohort converts at ${(cvr * 100).toFixed(2)}% — traffic is wrong-intent. Propose an audience / interest test, not another creative.`,
    evidence: [
      { field: "qualifying_creatives", value: qualified.length, threshold: 2 },
      { field: "cohort_cvr", value: round(cvr, 4), threshold: SIGNAL_LOW_COHORT_CVR },
      { field: "cohort_landing_page_views", value: totalLpv },
      { field: "cohort_purchases", value: totalPurchases },
      { field: "mean_ctr", value: round(meanCtr, 2), threshold: SIGNAL_HEALTHY_CTR_PCT },
      { field: "cohort_spend_cents", value: cohort.totals.spend_cents, threshold: gate.min_spend_cents },
    ],
    confidence: conf,
  };
}

/**
 * The Phase-2 entry — generate every applicable hypothesis over the Phase-1 brief.
 *
 * Pure + deterministic (a fixed brief always returns the same hypotheses). The `belowFloor`
 * list carries every creative dropped by the sample gate + the SPECIFIC gate that filtered it —
 * so the Director's verdict can narrate `no call — 3 Tabs creatives below the min-spend floor`
 * rather than silently omitting them.
 *
 * The `unknown` cohort (direct-in-Meta setups) NEVER emits a hypothesis — the Director can't
 * reason about a creative it can't attribute to a product. Those rows land on `belowFloor`
 * with reason `unknown_cohort`.
 */
export function generateGrowthHypotheses(
  brief: AnalyticalBriefResult,
  opts?: GenerateHypothesesOptions,
): HypothesesResult {
  const gate = resolveGate(opts?.gate);
  const hypotheses: Hypothesis[] = [];
  const belowFloor: BelowFloorEntry[] = [];

  // ── Per-creative reads ──────────────────────────────────────────────────
  for (const row of brief.rows) {
    if (row.cohort === UNKNOWN_COHORT) {
      belowFloor.push({
        cohort: row.cohort,
        cohort_label: row.cohort_label,
        meta_ad_id: row.meta_ad_id,
        reason: "unknown_cohort — creative could not be resolved to a product, skipped",
      });
      continue;
    }
    // funnel-not-creative — needs the funnel gate (spend + impressions + LPV).
    if (passesFunnelGate(row, gate)) {
      const h = funnelNotCreativeFor(row, gate);
      if (h) hypotheses.push(h);
    } else {
      belowFloor.push({
        cohort: row.cohort,
        cohort_label: row.cohort_label,
        meta_ad_id: row.meta_ad_id,
        reason: buildBelowFloorReason(row, gate, "funnel"),
      });
    }
    // delivery-anomaly — needs the delivery gate (spend + impressions). Independent read; a
    // creative that fails the funnel gate might still clear the delivery gate.
    if (passesDeliveryGate(row, gate)) {
      const h = deliveryAnomalyFor(row, gate);
      if (h) hypotheses.push(h);
    }
  }

  // ── Cohort-level reads (per unique cohort in the brief) ─────────────────
  for (const cohort of brief.cohorts) {
    if (cohort.cohort === UNKNOWN_COHORT) continue;
    if (!cohortPassesFormatGate(cohort, gate)) {
      belowFloor.push({
        cohort: cohort.cohort,
        cohort_label: cohort.cohort_label,
        reason: `cohort spend $${(cohort.totals.spend_cents / 100).toFixed(2)} below min-spend floor $${(gate.min_spend_cents / 100).toFixed(2)}`,
      });
      continue;
    }
    const fmt = formatEffectivenessFor(cohort, brief.rows, gate);
    if (fmt) hypotheses.push(fmt);
    const aud = audienceSignalFor(cohort, brief.rows, gate);
    if (aud) hypotheses.push(aud);
  }

  return { hypotheses, belowFloor, gate };
}

/** Build the specific below-floor reason for a per-creative gate miss — cites the gate that filtered. */
function buildBelowFloorReason(row: CreativeScorecardRow, gate: SampleGate, mode: "funnel"): string {
  const misses: string[] = [];
  if (row.meta.spend_cents < gate.min_spend_cents) {
    misses.push(`spend $${(row.meta.spend_cents / 100).toFixed(2)} < min $${(gate.min_spend_cents / 100).toFixed(2)}`);
  }
  if (row.meta.impressions < gate.min_impressions) {
    misses.push(`impressions ${row.meta.impressions} < min ${gate.min_impressions}`);
  }
  if (mode === "funnel" && row.funnel.landing_page_views < gate.min_landing_page_views) {
    misses.push(`landing_page_views ${row.funnel.landing_page_views} < min ${gate.min_landing_page_views}`);
  }
  return `sample gate — ${misses.join(", ")}`;
}

// Re-export the shape types callers thread from Phase 1 → Phase 2 without importing both modules.
export type { CreativeScorecardRow, CohortSummary, AnalyticalBriefResult, VariantAttribution };
