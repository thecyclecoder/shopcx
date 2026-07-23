/**
 * Unit tests for the Media Buyer grader — media-buyer-test-winner-loop Phase 3
 * verification harness.
 *
 * The spec's Phase 3 verification calls out:
 *   • The grading pass, run over >=1 concluded media-buyer action with settled
 *     attribution, writes a grade row carrying decision_quality + outcome_quality
 *     + cited ROAS.
 *   • grep/test confirms grades READ REALIZED ROAS (from meta_attribution_daily
 *     3d+ later), not the pre-launch projection.
 *   • The rubric: "a sound call that regressed on a later ROAS shift still grades
 *     well" — decision_quality is scored on the DECISION-TIME signals, outcome_quality
 *     on the REALIZED signals; the two axes are orthogonal.
 *
 * Run:
 *   npx tsx --test src/lib/media-buyer/grader.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreMediaBuyerAction,
  type MediaBuyerActionRow,
  type RealizedAttribution,
} from "./grader";
import type { IterationPolicy } from "@/lib/meta/decision-engine";

function policy(overrides: Partial<IterationPolicy> = {}): IterationPolicy {
  return {
    id: "policy-1",
    version: 1,
    roas_floor: 1.5,
    scale_up_roas_trigger: 3.0,
    scale_up_step_pct: 0.15,
    scale_up_cap_pct: 0.25,
    scale_down_step_pct: 0.2,
    pause_min_spend_cents: 5_000,
    pause_window_days: 7,
    unpause_sales_after_pause: 0,
    unpause_lookback_days: 14,
    min_creatives_per_adset: 0,
    per_object_cooldown_hours: 24,
    per_account_daily_budget_delta_ceiling_cents: 100_000,
    min_budget_floor_cents: 1_000,
    never_pause_object_ids: [],
    mode: "armed",
    trust_meta_reported_signal: false,
    crown_max_cpa_cents: null,
    crown_min_spend_cents: null,
    early_trim_min_spend_cents: null,
    trim_max_cost_per_atc_cents: null,
    trim_max_cpm_cents: null,
    crown_min_purchases: null,
    hold_band_max_cpa_cents: null,
    max_test_spend_cents: null,
    slow_kill_min_spend_cents: null,
    slow_kill_max_cpa_cents: null,
    ...overrides,
  };
}

function promoteAction(overrides: Partial<MediaBuyerActionRow> = {}): MediaBuyerActionRow {
  return {
    id: "da-1",
    workspace_id: "ws-1",
    action_kind: "media_buyer_promoted_winner",
    created_at: "2026-07-01T00:00:00.000Z",
    metadata: { source_meta_ad_id: "meta_ad_winner_1", roas: 4.0, spend_cents: 20_000 },
    ...overrides,
  };
}

function killAction(overrides: Partial<MediaBuyerActionRow> = {}): MediaBuyerActionRow {
  return {
    id: "da-2",
    workspace_id: "ws-1",
    action_kind: "media_buyer_paused_loser",
    created_at: "2026-07-01T00:00:00.000Z",
    metadata: { source_meta_ad_id: "meta_ad_loser_1", roas: 0.5, spend_cents: 10_000 },
    ...overrides,
  };
}

function realized(spend: number, revenue: number): RealizedAttribution {
  return {
    spendCents: spend,
    revenueCents: revenue,
    roas: spend > 0 ? Number((revenue / spend).toFixed(4)) : null,
    windowStart: "2026-07-04",
    windowEnd: "2026-07-11",
  };
}

// ── Verification #1 — grade row carries decision + outcome + cited ROAS ──────

test("scoreMediaBuyerAction — promote on strong winner + realized ROAS holds → high overall grade", () => {
  const grade = scoreMediaBuyerAction(
    promoteAction({ metadata: { source_meta_ad_id: "meta_ad_1", roas: 5.0 } }),
    policy(),
    realized(10_000, 40_000), // realized ROAS 4.0 — above trigger 3.0
  );
  assert.equal(grade.actionKind, "media_buyer_promoted_winner");
  assert.equal(grade.sourceMetaAdId, "meta_ad_1");
  assert.equal(grade.decisionRoas, 5.0);
  assert.equal(grade.realized?.roas, 4.0);
  assert.equal(grade.decisionQuality, 10); // decision-time ROAS 5.0 ≥ trigger 3.0 × 1.5
  assert.equal(grade.outcomeQuality, 10); // realized ROAS 4.0 ≥ trigger
  assert.equal(grade.overallGrade, 10);
});

// ── Verification #2 — "a sound call that regressed still grades well" ────────

test("scoreMediaBuyerAction — SOUND promote whose realized ROAS regressed → HIGH decision_quality, LOW outcome_quality (rubric)", () => {
  const grade = scoreMediaBuyerAction(
    promoteAction({ metadata: { source_meta_ad_id: "meta_ad_1", roas: 5.0 } }), // decision-time ROAS 5.0
    policy(),
    realized(10_000, 10_000), // realized ROAS 1.0 — well below floor 1.5
  );
  assert.ok(grade.decisionQuality >= 8, `decision_quality should stay HIGH (sound call); got ${grade.decisionQuality}`);
  assert.ok(grade.outcomeQuality <= 5, `outcome_quality should be LOW (regressed); got ${grade.outcomeQuality}`);
  // Overall averages the two — still credited for the sound decision.
  assert.ok(grade.overallGrade >= 5 && grade.overallGrade <= 8);
});

// ── Verification #3 — realized ROAS is read (not the pre-launch projection) ──

test("scoreMediaBuyerAction — outcome_quality is scored against REALIZED ROAS, not decision-time ROAS", () => {
  // Decision-time ROAS = 5.0 (a "clear winner"); realized ROAS = 0.5 (disaster).
  // If outcome_quality were scored against decision-time, it would be high;
  // it should be LOW because it's scored against REALIZED.
  const decisionTimeGreat = scoreMediaBuyerAction(
    promoteAction({ metadata: { source_meta_ad_id: "meta_ad_1", roas: 5.0 } }),
    policy(),
    realized(10_000, 5_000),
  );
  assert.ok(decisionTimeGreat.outcomeQuality <= 3, `outcome scored against REALIZED (should be low); got ${decisionTimeGreat.outcomeQuality}`);
});

// ── Kill (pause) scoring ─────────────────────────────────────────────────────

test("scoreMediaBuyerAction — deep-loser kill + paused-object no-realized-spend → maximal decision + outcome", () => {
  const grade = scoreMediaBuyerAction(
    killAction({ metadata: { source_meta_ad_id: "meta_ad_loser_1", roas: 0.4 } }), // deep below floor
    policy(),
    realized(0, 0), // paused → no realized spend
  );
  assert.equal(grade.actionKind, "media_buyer_paused_loser");
  assert.equal(grade.decisionQuality, 10);
  assert.equal(grade.outcomeQuality, 10);
});

test("scoreMediaBuyerAction — kill on a marginal loser (just below floor) → lower decision_quality", () => {
  const grade = scoreMediaBuyerAction(
    killAction({ metadata: { source_meta_ad_id: "meta_ad_loser_1", roas: 1.4 } }), // marginal
    policy(),
    realized(0, 0),
  );
  assert.ok(grade.decisionQuality <= 6, `marginal kill should score decision_quality ≤ 6; got ${grade.decisionQuality}`);
});

test("scoreMediaBuyerAction — a KILL that should not have fired (ROAS at/above floor) grades poorly on decision_quality", () => {
  const grade = scoreMediaBuyerAction(
    killAction({ metadata: { source_meta_ad_id: "meta_ad_loser_1", roas: 1.6 } }), // above floor 1.5
    policy(),
    realized(0, 0),
  );
  assert.ok(grade.decisionQuality <= 3);
});

// ── Fatigue-replenish + supply-side replenish ────────────────────────────────

test("scoreMediaBuyerAction — fatigue_replenish uses the same promote-style scoring", () => {
  const grade = scoreMediaBuyerAction(
    {
      id: "da-3",
      workspace_id: "ws-1",
      action_kind: "media_buyer_fatigue_replenish_triggered",
      created_at: "2026-07-01T00:00:00.000Z",
      metadata: { source_meta_ad_id: "meta_ad_1", roas: 4.5, fatigue_score: 0.7 },
    },
    policy(),
    realized(5_000, 20_000), // realized ROAS 4.0 — above trigger
  );
  assert.equal(grade.actionKind, "media_buyer_fatigue_replenish_triggered");
  assert.ok(grade.decisionQuality >= 9);
  assert.equal(grade.outcomeQuality, 10);
});

test("scoreMediaBuyerAction — replenished_test_cohort defaults to sound decision + realized-based outcome", () => {
  const grade = scoreMediaBuyerAction(
    {
      id: "da-4",
      workspace_id: "ws-1",
      action_kind: "media_buyer_replenished_test_cohort",
      created_at: "2026-07-01T00:00:00.000Z",
      metadata: { source_meta_ad_id: "meta_ad_new_test", ad_campaign_id: "cmp-1" },
    },
    policy(),
    null, // no realized attribution yet — the ad didn't sustain spend
  );
  assert.equal(grade.decisionQuality, 8);
  // No realized → outcome_quality = 4 (weak outcome, the ad didn't get traction).
  assert.equal(grade.outcomeQuality, 4);
});

// ── Reasoning + citations ───────────────────────────────────────────────────

test("scoreMediaBuyerAction — reasoning cites the ROAS numbers on both axes", () => {
  const grade = scoreMediaBuyerAction(
    promoteAction({ metadata: { source_meta_ad_id: "meta_ad_1", roas: 4.0 } }),
    policy(),
    realized(1_000, 3_000), // realized ROAS 3.0 — at trigger
  );
  assert.ok(grade.reasoning.includes("4.00")); // decision-time ROAS
  assert.ok(grade.reasoning.toLowerCase().includes("decision"));
  assert.ok(grade.reasoning.toLowerCase().includes("outcome"));
});

test("scoreMediaBuyerAction — missing decision-time ROAS metadata → decision_quality = 4 (unable to judge)", () => {
  const grade = scoreMediaBuyerAction(
    promoteAction({ metadata: { source_meta_ad_id: "meta_ad_1" } }), // NO roas
    policy(),
    realized(1_000, 3_500),
  );
  assert.equal(grade.decisionRoas, null);
  assert.equal(grade.decisionQuality, 4);
});
