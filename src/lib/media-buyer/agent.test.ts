/**
 * Unit tests for the Media Buyer plan computer — media-buyer-test-winner-loop
 * Phase 2 verification harness.
 *
 * The spec's Phase 2 verification calls out:
 *   • A pass against a state with >=1 detected winner emits a typed plan
 *     containing at least one PROMOTE action.
 *   • When a loser exists, the plan ALSO contains a KILL action.
 *   • Each action carries the source meta_ad_id + its ROAS.
 *   • The runner writes matching director_activity rows (that's the orchestrator's
 *     surface; here we cover the pure plan-computer.)
 *   • With an active iteration_policies row present, the loop produces non-empty
 *     action sets (vs empty when no policy).
 *
 * Run:
 *   npx tsx --test src/lib/media-buyer/agent.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildShadowActivityRows,
  computeMediaBuyerPlan,
  DEFAULT_FATIGUE_REPLENISH_VARIANTS,
  DEFAULT_TEST_COHORT_TARGET,
  evaluateSensorTrustSnapshot,
  FATIGUE_REPLENISH_THRESHOLD,
  readActiveCohortProductIds,
  readCurrentTestCohortSize,
  resolveReplenishAdCopy,
  SENSOR_TRUST_MAX_AGE_MS,
  type MediaBuyerLoser,
  type MediaBuyerPlanInputs,
  type SensorTrustSnapshot,
} from "./agent";
import { listReadyToTest } from "@/lib/ads/ready-to-test";
import type { DetectedWinner } from "@/lib/ads/winning-creative-detect";
import type { IterationPolicy } from "@/lib/meta/decision-engine";
import type { MediaBuyerTestCohort } from "@/lib/media-buyer/publish-gate";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const WS = "ws-1";

function policy(overrides: Partial<IterationPolicy> = {}): IterationPolicy {
  return {
    id: "policy-1",
    version: 1,
    roas_floor: 1.5,
    scale_up_roas_trigger: 3.0,
    scale_up_step_pct: 0.15,
    scale_up_cap_pct: 0.25,
    scale_down_step_pct: 0.2,
    pause_min_spend_cents: 5_000, // $50
    pause_window_days: 7,
    unpause_sales_after_pause: 0,
    unpause_lookback_days: 14,
    min_creatives_per_adset: 0,
    per_object_cooldown_hours: 24,
    per_account_daily_budget_delta_ceiling_cents: 100_000, // $1000
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
    ...overrides,
  };
}

function cohort(overrides: Partial<MediaBuyerTestCohort> = {}): MediaBuyerTestCohort {
  return {
    id: "cohort-1",
    workspaceId: WS,
    metaAdAccountId: null,
    productId: null,
    testMetaAdsetId: "6100000000001",
    dailyTestCeilingCents: 50_000,
    isActive: true,
    notes: null,
    updatedBy: null,
    createdAt: "",
    updatedAt: "",
    defaultMetaAccountId: "act-1",
    defaultMetaPageId: "page-1",
    defaultMetaInstagramUserId: null,
    adsetPerTest: false,
    testMetaCampaignId: null,
    perTestDailyBudgetCents: 15_000,
    adsetTemplate: null,
    ...overrides,
  };
}

function winner(overrides: Partial<DetectedWinner> = {}): DetectedWinner {
  return {
    workspaceId: WS,
    metaAdId: "meta_ad_winner_1",
    variant: "advertorial",
    spendCents: 20_000, // $200
    onsiteCents: 80_000, // $800
    haloAdjustedRevenueCents: 80_000,
    roas: 4.0, // above scale_up_roas_trigger=3.0
    sessions: 400,
    windowStart: "2026-06-20",
    windowEnd: "2026-07-04",
    campaign: null,
    angle: null,
    ...overrides,
  };
}

function loser(overrides: Partial<MediaBuyerLoser> = {}): MediaBuyerLoser {
  return {
    sourceMetaAdId: "meta_ad_loser_1",
    targetLevel: "adset",
    targetObjectId: "6100000000123",
    roas: 0.5, // way below roas_floor=1.5
    spendCents: 10_000, // $100 — above pause_min_spend_cents=$50
    triggeringScorecardId: "score-loser-1",
    ...overrides,
  };
}

function baseInputs(overrides: Partial<MediaBuyerPlanInputs> = {}): MediaBuyerPlanInputs {
  return {
    policy: policy(),
    cohort: cohort(),
    winners: [],
    losers: [],
    metaAdIdToAdsetId: new Map(),
    budgets: new Map(),
    readyToTest: [],
    currentTestCohortSize: DEFAULT_TEST_COHORT_TARGET,
    ...overrides,
  };
}

// ── Verification #1 — winner + loser → promote + kill actions ────────────────

test("computeMediaBuyerPlan — winner emits a PROMOTE carrying source meta_ad_id + ROAS", () => {
  const w = winner();
  const plan = computeMediaBuyerPlan(
    baseInputs({
      winners: [w],
      metaAdIdToAdsetId: new Map([[w.metaAdId, "adset-parent-1"]]),
      budgets: new Map([["adset-parent-1", 20_000]]), // $200 daily
    }),
  );
  assert.equal(plan.policyActive, true);
  assert.equal(plan.promote.length, 1);
  const p = plan.promote[0];
  assert.equal(p.sourceMetaAdId, w.metaAdId);
  assert.equal(p.roas, w.roas);
  assert.equal(p.targetLevel, "adset");
  assert.equal(p.targetObjectId, "adset-parent-1");
  assert.equal(p.beforeBudgetCents, 20_000);
  assert.equal(p.afterBudgetCents, 23_000); // 20_000 * 1.15
  assert.ok(p.rationale.includes(w.metaAdId));
  assert.ok(p.rationale.includes("ROAS"));
});

test("computeMediaBuyerPlan — loser emits a KILL carrying source meta_ad_id + ROAS", () => {
  const l = loser();
  const plan = computeMediaBuyerPlan(baseInputs({ losers: [l] }));
  assert.equal(plan.kill.length, 1);
  const k = plan.kill[0];
  assert.equal(k.sourceMetaAdId, l.sourceMetaAdId);
  assert.equal(k.roas, l.roas);
  assert.equal(k.targetLevel, "adset");
  assert.equal(k.targetObjectId, l.targetObjectId);
  assert.ok(k.rationale.includes("roas_floor"));
  assert.ok(k.rationale.includes(l.sourceMetaAdId));
});

test("computeMediaBuyerPlan — mixed: winner + loser fixture → BOTH promote + kill actions", () => {
  const w = winner();
  const l = loser();
  const plan = computeMediaBuyerPlan(
    baseInputs({
      winners: [w],
      losers: [l],
      metaAdIdToAdsetId: new Map([[w.metaAdId, "adset-parent-1"]]),
      budgets: new Map([["adset-parent-1", 20_000]]),
    }),
  );
  assert.equal(plan.promote.length, 1);
  assert.equal(plan.kill.length, 1);
  // Each of the two actions carries the source meta_ad_id + ROAS — the exact
  // pair the spec's verification calls out.
  assert.equal(plan.promote[0].sourceMetaAdId, w.metaAdId);
  assert.equal(plan.promote[0].roas, w.roas);
  assert.equal(plan.kill[0].sourceMetaAdId, l.sourceMetaAdId);
  assert.equal(plan.kill[0].roas, l.roas);
});

// ── Verification #2 — no active policy → empty plan (loop dormant) ───────────

test("computeMediaBuyerPlan — no active policy → dormant plan (0 actions, ever)", () => {
  const w = winner();
  const l = loser();
  const plan = computeMediaBuyerPlan(
    baseInputs({
      policy: null,
      winners: [w],
      losers: [l],
      metaAdIdToAdsetId: new Map([[w.metaAdId, "adset-parent-1"]]),
      budgets: new Map([["adset-parent-1", 20_000]]),
    }),
  );
  assert.equal(plan.policyActive, false);
  assert.equal(plan.policyVersionId, null);
  assert.equal(plan.promote.length, 0);
  assert.equal(plan.kill.length, 0);
  assert.equal(plan.replenish.length, 0);
  assert.ok(plan.summary.toLowerCase().includes("no active"));
});

// ── Verification #3 — policy present → non-empty plan for a real winner ─────

test("computeMediaBuyerPlan — active policy + winner → non-empty action set (mirrors decision-engine)", () => {
  const w = winner();
  const plan = computeMediaBuyerPlan(
    baseInputs({
      winners: [w],
      metaAdIdToAdsetId: new Map([[w.metaAdId, "adset-1"]]),
      budgets: new Map([["adset-1", 15_000]]),
    }),
  );
  assert.ok(plan.promote.length > 0, "policy present + winner → at least one promote action");
});

// ── Guardrail branches ──────────────────────────────────────────────────────

test("computeMediaBuyerPlan — winner below scale_up_roas_trigger is NOT promoted", () => {
  const w = winner({ roas: 2.0 }); // trigger=3.0
  const plan = computeMediaBuyerPlan(
    baseInputs({
      winners: [w],
      metaAdIdToAdsetId: new Map([[w.metaAdId, "adset-1"]]),
      budgets: new Map([["adset-1", 10_000]]),
    }),
  );
  assert.equal(plan.promote.length, 0);
});

test("computeMediaBuyerPlan — loser below pause_min_spend_cents is NOT killed", () => {
  const l = loser({ spendCents: 100 }); // way below $50 floor
  const plan = computeMediaBuyerPlan(baseInputs({ losers: [l] }));
  assert.equal(plan.kill.length, 0);
});

test("computeMediaBuyerPlan — never_pause_object_ids blocks the kill", () => {
  const l = loser({ targetObjectId: "protected-adset" });
  const plan = computeMediaBuyerPlan(
    baseInputs({
      losers: [l],
      policy: policy({ never_pause_object_ids: ["protected-adset"] }),
    }),
  );
  assert.equal(plan.kill.length, 0);
});

test("computeMediaBuyerPlan — winner with no parent adset resolved is skipped (safe)", () => {
  const w = winner();
  const plan = computeMediaBuyerPlan(
    baseInputs({
      winners: [w],
      metaAdIdToAdsetId: new Map(), // no lookup — the winner's parent adset is unknown
      budgets: new Map(),
    }),
  );
  assert.equal(plan.promote.length, 0);
});

// ── Replenish ──────────────────────────────────────────────────────────────

test("computeMediaBuyerPlan — inactive cohort → no replenish, summary flags dormant cohort", () => {
  const plan = computeMediaBuyerPlan(
    baseInputs({
      cohort: cohort({ isActive: false }),
      readyToTest: [
        { ad_campaign_id: "cmp-1", archetype: null, lander_url: "https://x", status: "ready_no_active_ad", formats: [], created_at: "" },
      ],
      currentTestCohortSize: 0,
    }),
  );
  assert.equal(plan.replenish.length, 0);
  assert.ok(plan.summary.includes("cohort dormant"));
});

test("computeMediaBuyerPlan — cohort deficit → replenish up to deficit, capped by ready-to-test bin", () => {
  const plan = computeMediaBuyerPlan(
    baseInputs({
      currentTestCohortSize: 1,
      cohortTargetCount: 3, // deficit=2
      readyToTest: [
        { ad_campaign_id: "cmp-1", archetype: null, lander_url: "https://x1", status: "ready_no_active_ad", formats: [], created_at: "" },
        { ad_campaign_id: "cmp-2", archetype: null, lander_url: "https://x2", status: "ready_no_active_ad", formats: [], created_at: "" },
        { ad_campaign_id: "cmp-3", archetype: null, lander_url: "https://x3", status: "ready_no_active_ad", formats: [], created_at: "" },
      ],
    }),
  );
  assert.equal(plan.replenish.length, 2);
  assert.equal(plan.replenish[0].adCampaignId, "cmp-1");
  assert.equal(plan.replenish[1].adCampaignId, "cmp-2");
  assert.equal(plan.replenish[0].testMetaAdsetId, "6100000000001");
});

test("computeMediaBuyerPlan — cohort at target → 0 replenish", () => {
  const plan = computeMediaBuyerPlan(
    baseInputs({
      currentTestCohortSize: DEFAULT_TEST_COHORT_TARGET,
      readyToTest: [
        { ad_campaign_id: "cmp-1", archetype: null, lander_url: "https://x1", status: "ready_no_active_ad", formats: [], created_at: "" },
      ],
    }),
  );
  assert.equal(plan.replenish.length, 0);
});

// ── Per-test-adset cohort (CEO 2026-07-12) ──────────────────────────────────

test("computeMediaBuyerPlan — per-test cohort derives target from ceiling÷per-test (4 at $600/$150) and flags adsetPerTest", () => {
  const perTest = cohort({
    adsetPerTest: true,
    testMetaAdsetId: null,
    testMetaCampaignId: "camp-PT",
    perTestDailyBudgetCents: 15_000, // $150
    dailyTestCeilingCents: 60_000, // $600 → target 4
  });
  const plan = computeMediaBuyerPlan(
    baseInputs({
      cohort: perTest,
      currentTestCohortSize: 1, // 1 live → deficit 3
      cohortTargetCount: undefined, // per-test ignores the override; derives from budget math
      readyToTest: [
        { ad_campaign_id: "cmp-1", archetype: null, lander_url: "https://x1", status: "ready_no_active_ad", formats: [], created_at: "" },
        { ad_campaign_id: "cmp-2", archetype: null, lander_url: "https://x2", status: "ready_no_active_ad", formats: [], created_at: "" },
        { ad_campaign_id: "cmp-3", archetype: null, lander_url: "https://x3", status: "ready_no_active_ad", formats: [], created_at: "" },
        { ad_campaign_id: "cmp-4", archetype: null, lander_url: "https://x4", status: "ready_no_active_ad", formats: [], created_at: "" },
      ],
    }),
  );
  assert.equal(plan.cohortTargetCount, 4); // ceiling ÷ per-test, NOT DEFAULT_TEST_COHORT_TARGET
  assert.equal(plan.replenish.length, 3); // deficit 3
  for (const r of plan.replenish) {
    assert.equal(r.adsetPerTest, true);
    assert.equal(r.testMetaAdsetId, null); // per-test mints a fresh adset at publish
  }
});

// ── Phase 3 — fatigue-triggered replenish ────────────────────────────────────

test("computeMediaBuyerPlan — fatiguing WINNER (fatigue past threshold) → fatigue_replenish action citing meta_ad_id + fatigue_score", () => {
  const w = winner(); // ROAS 4.0, above trigger 3.0
  const plan = computeMediaBuyerPlan(
    baseInputs({
      winners: [w],
      metaAdIdToAdsetId: new Map([[w.metaAdId, "adset-parent-1"]]),
      budgets: new Map([["adset-parent-1", 20_000]]),
      // Fatigue score above the FATIGUE_REPLENISH_THRESHOLD → fires.
      fatigueByAdsetId: new Map([["adset-parent-1", FATIGUE_REPLENISH_THRESHOLD + 0.1]]),
    }),
  );
  assert.equal(plan.fatigueReplenish.length, 1);
  const f = plan.fatigueReplenish[0];
  assert.equal(f.sourceMetaAdId, w.metaAdId);
  assert.equal(f.roas, w.roas);
  assert.equal(f.fatigueScore, FATIGUE_REPLENISH_THRESHOLD + 0.1);
  assert.equal(f.variantCount, DEFAULT_FATIGUE_REPLENISH_VARIANTS);
  assert.ok(f.rationale.includes(w.metaAdId));
  assert.ok(f.rationale.includes("fatigue_score"));
});

test("computeMediaBuyerPlan — non-fatiguing winner → NO fatigue_replenish action", () => {
  const w = winner();
  const plan = computeMediaBuyerPlan(
    baseInputs({
      winners: [w],
      metaAdIdToAdsetId: new Map([[w.metaAdId, "adset-parent-1"]]),
      budgets: new Map([["adset-parent-1", 20_000]]),
      fatigueByAdsetId: new Map([["adset-parent-1", FATIGUE_REPLENISH_THRESHOLD - 0.1]]), // just below
    }),
  );
  assert.equal(plan.fatigueReplenish.length, 0);
});

test("computeMediaBuyerPlan — winner missing fatigue signal (no scorecard row) → NO fatigue_replenish", () => {
  const w = winner();
  const plan = computeMediaBuyerPlan(
    baseInputs({
      winners: [w],
      metaAdIdToAdsetId: new Map([[w.metaAdId, "adset-parent-1"]]),
      budgets: new Map([["adset-parent-1", 20_000]]),
      // fatigueByAdsetId omitted entirely — signal missing → don't fire.
    }),
  );
  assert.equal(plan.fatigueReplenish.length, 0);
});

test("computeMediaBuyerPlan — sub-trigger winner is NEVER fatigue-replenished even at high fatigue", () => {
  const w = winner({ roas: 2.0 }); // below scale_up_roas_trigger=3.0
  const plan = computeMediaBuyerPlan(
    baseInputs({
      winners: [w],
      metaAdIdToAdsetId: new Map([[w.metaAdId, "adset-parent-1"]]),
      budgets: new Map([["adset-parent-1", 20_000]]),
      fatigueByAdsetId: new Map([["adset-parent-1", 0.95]]), // very high fatigue
    }),
  );
  // Only REAL winners qualify — fatigue-replenish assumes a winning angle worth cloning.
  assert.equal(plan.fatigueReplenish.length, 0);
});

// ── media-buyer-sensor-trust-probe Phase 3 — sensor_trust_ok short-circuit ──

const NOW_MS = Date.UTC(2026, 6, 8, 12, 0, 0); // 2026-07-08T12:00:00Z, fixed for age math

function snapshot(overrides: Partial<SensorTrustSnapshot> = {}): SensorTrustSnapshot {
  return {
    snapshot_date: "2026-07-07",
    band: "green",
    coverage_ratio: 0.85,
    reasons: [],
    // Fresh: exactly 1h old vs NOW_MS.
    created_at: new Date(NOW_MS - 3600_000).toISOString(),
    ...overrides,
  };
}

test("evaluateSensorTrustSnapshot — missing snapshot → deny with missing_snapshot", () => {
  const denial = evaluateSensorTrustSnapshot(null, NOW_MS);
  assert.ok(denial, "null snapshot should deny");
  assert.equal(denial.band, null);
  assert.equal(denial.snapshot_date, null);
  assert.deepEqual(denial.reasons, ["missing_snapshot"]);
  assert.ok(denial.reason.toLowerCase().includes("no media_buyer_sensor_trust snapshot"));
});

test("evaluateSensorTrustSnapshot — stale snapshot (72h old) → deny with stale_snapshot in reasons", () => {
  // 72h old → past the 48h cap. Even a band='green' snapshot cannot rescue it.
  const s = snapshot({
    band: "green",
    reasons: ["low_unresolved_share_within_cap"],
    created_at: new Date(NOW_MS - 72 * 3600_000).toISOString(),
  });
  const denial = evaluateSensorTrustSnapshot(s, NOW_MS);
  assert.ok(denial, "stale snapshot must deny");
  assert.equal(denial.band, "green");
  assert.equal(denial.snapshot_date, s.snapshot_date);
  // Existing reasons preserved + stale_snapshot appended.
  assert.ok(denial.reasons.includes("low_unresolved_share_within_cap"));
  assert.ok(denial.reasons.includes("stale_snapshot"));
  assert.ok(denial.reason.toLowerCase().includes("stale"));
});

test("evaluateSensorTrustSnapshot — band='red' fresh snapshot → deny (attribution untrusted)", () => {
  const s = snapshot({
    band: "red",
    coverage_ratio: 0.3,
    reasons: ["low_coverage", "unresolved_share_over_cap"],
  });
  const denial = evaluateSensorTrustSnapshot(s, NOW_MS);
  assert.ok(denial, "red band must deny");
  assert.equal(denial.band, "red");
  assert.equal(denial.coverage_ratio, 0.3);
  // The probe's own reasons flow through — the runner records them verbatim on
  // the director_activity row (spec: metadata={reasons, snapshot_date, band, coverage_ratio}).
  assert.deepEqual(denial.reasons, ["low_coverage", "unresolved_share_over_cap"]);
  assert.ok(denial.reason.toLowerCase().includes("red"));
});

test("evaluateSensorTrustSnapshot — fresh band='green' → allow (returns null)", () => {
  const s = snapshot({ band: "green" });
  const denial = evaluateSensorTrustSnapshot(s, NOW_MS);
  assert.equal(denial, null, "fresh green snapshot must NOT deny");
});

test("evaluateSensorTrustSnapshot — fresh band='yellow' → allow (yellow is a warning, not a refusal)", () => {
  // Yellow is the probe's own "borderline" carrier — the runner still proceeds so
  // Shadow-mode calls land; only red short-circuits per spec Phase 3.
  const s = snapshot({ band: "yellow", coverage_ratio: 0.6 });
  const denial = evaluateSensorTrustSnapshot(s, NOW_MS);
  assert.equal(denial, null, "fresh yellow snapshot must NOT deny");
});

test("evaluateSensorTrustSnapshot — snapshot exactly at the freshness cap (48h) is still allowed", () => {
  // Boundary — 48h exactly is inside the cap (≤, not <).
  const s = snapshot({
    band: "green",
    created_at: new Date(NOW_MS - SENSOR_TRUST_MAX_AGE_MS).toISOString(),
  });
  const denial = evaluateSensorTrustSnapshot(s, NOW_MS);
  assert.equal(denial, null, "exact-cap snapshot must NOT deny");
});

test("evaluateSensorTrustSnapshot — 48h+1ms is stale → deny", () => {
  // Boundary — 1ms past the cap trips the freshness guard.
  const s = snapshot({
    band: "green",
    created_at: new Date(NOW_MS - SENSOR_TRUST_MAX_AGE_MS - 1).toISOString(),
  });
  const denial = evaluateSensorTrustSnapshot(s, NOW_MS);
  assert.ok(denial, "48h+1ms snapshot must deny");
  assert.ok(denial.reasons.includes("stale_snapshot"));
});

test("evaluateSensorTrustSnapshot — malformed created_at → deny (defensive: infinite age)", () => {
  const s = snapshot({ band: "green", created_at: "not-a-date" });
  const denial = evaluateSensorTrustSnapshot(s, NOW_MS);
  assert.ok(denial, "unparseable created_at must fail closed");
  assert.ok(denial.reasons.includes("stale_snapshot"));
});

// ── media-buyer-shadow-mode Phase 2 — shadow persistence rows ────────────────
//
// The runner's shadow branch is a pure emit-only path — `iteration_actions` and
// `ad_publish_jobs` writes are gated behind `policy.mode === 'armed'` (early-return
// on shadow, executor writes preserved on armed). The pure `buildShadowActivityRows`
// helper is the SEAM the runner uses to shape the shadow-mode director_activity rows,
// so we pin its shape here — one row per plan action, `<verb>_shadow` action_kind,
// and metadata carrying mode='shadow' + the full plan_action + the source citation
// (source_meta_ad_id / roas / policy_version_id) the audit trail depends on.

test("buildShadowActivityRows — promote action → media_buyer_promoted_winner_shadow with mode+plan_action metadata", () => {
  const w = winner();
  const plan = computeMediaBuyerPlan(
    baseInputs({
      winners: [w],
      metaAdIdToAdsetId: new Map([[w.metaAdId, "adset-parent-1"]]),
      budgets: new Map([["adset-parent-1", 20_000]]),
    }),
  );
  const rows = buildShadowActivityRows(plan);
  const promoteRow = rows.find((r) => r.actionKind === "media_buyer_promoted_winner_shadow");
  assert.ok(promoteRow, "shadow rows include a media_buyer_promoted_winner_shadow row for the promote action");
  assert.equal(promoteRow.metadata.mode, "shadow");
  assert.equal(promoteRow.metadata.source_meta_ad_id, w.metaAdId);
  assert.equal(promoteRow.metadata.roas, w.roas);
  assert.equal(promoteRow.metadata.policy_version_id, plan.policyVersionId);
  // The full plan_action JSON travels on the row so a human reviewer sees the
  // exact same shape the armed executor would consume — no paraphrase.
  const planAction = promoteRow.metadata.plan_action as { kind?: string };
  assert.equal(planAction.kind, "promote");
});

test("buildShadowActivityRows — kill action → media_buyer_paused_loser_shadow with mode+plan_action metadata", () => {
  const l = loser();
  const plan = computeMediaBuyerPlan(baseInputs({ losers: [l] }));
  const rows = buildShadowActivityRows(plan);
  const killRow = rows.find((r) => r.actionKind === "media_buyer_paused_loser_shadow");
  assert.ok(killRow, "shadow rows include a media_buyer_paused_loser_shadow row for the kill action");
  assert.equal(killRow.metadata.mode, "shadow");
  assert.equal(killRow.metadata.source_meta_ad_id, l.sourceMetaAdId);
  assert.equal(killRow.metadata.roas, l.roas);
  const planAction = killRow.metadata.plan_action as { kind?: string };
  assert.equal(planAction.kind, "kill");
});

test("buildShadowActivityRows — replenish action → media_buyer_replenished_test_cohort_shadow with mode+plan_action metadata", () => {
  const plan = computeMediaBuyerPlan(
    baseInputs({
      currentTestCohortSize: 1,
      cohortTargetCount: 3,
      readyToTest: [
        { ad_campaign_id: "cmp-1", archetype: null, lander_url: "https://x1", status: "ready_no_active_ad", formats: [], created_at: "" },
      ],
    }),
  );
  const rows = buildShadowActivityRows(plan);
  const replenishRow = rows.find((r) => r.actionKind === "media_buyer_replenished_test_cohort_shadow");
  assert.ok(replenishRow, "shadow rows include a media_buyer_replenished_test_cohort_shadow row for the replenish action");
  assert.equal(replenishRow.metadata.mode, "shadow");
  assert.equal(replenishRow.metadata.policy_version_id, plan.policyVersionId);
  const planAction = replenishRow.metadata.plan_action as { kind?: string; adCampaignId?: string };
  assert.equal(planAction.kind, "replenish");
  assert.equal(planAction.adCampaignId, "cmp-1");
});

test("buildShadowActivityRows — fatigue_replenish action → media_buyer_fatigue_replenish_triggered_shadow row", () => {
  const w = winner();
  const plan = computeMediaBuyerPlan(
    baseInputs({
      winners: [w],
      metaAdIdToAdsetId: new Map([[w.metaAdId, "adset-parent-1"]]),
      budgets: new Map([["adset-parent-1", 20_000]]),
      fatigueByAdsetId: new Map([["adset-parent-1", FATIGUE_REPLENISH_THRESHOLD + 0.1]]),
    }),
  );
  const rows = buildShadowActivityRows(plan);
  const fatigueRow = rows.find((r) => r.actionKind === "media_buyer_fatigue_replenish_triggered_shadow");
  assert.ok(fatigueRow, "shadow rows include a media_buyer_fatigue_replenish_triggered_shadow row");
  assert.equal(fatigueRow.metadata.mode, "shadow");
  assert.equal(fatigueRow.metadata.source_meta_ad_id, w.metaAdId);
  assert.equal(fatigueRow.metadata.roas, w.roas);
  const planAction = fatigueRow.metadata.plan_action as { kind?: string };
  assert.equal(planAction.kind, "fatigue_replenish");
});

test("buildShadowActivityRows — empty plan → zero shadow rows (heartbeat is the runner's separate emit)", () => {
  const plan = computeMediaBuyerPlan(baseInputs()); // no winners, no losers, cohort at target
  const rows = buildShadowActivityRows(plan);
  assert.equal(rows.length, 0, "no plan actions ⇒ no per-action shadow rows");
});

test("buildShadowActivityRows — mixed plan → one row per plan action (promote + kill + replenish + fatigue)", () => {
  const w = winner();
  const l = loser();
  const plan = computeMediaBuyerPlan(
    baseInputs({
      winners: [w],
      losers: [l],
      metaAdIdToAdsetId: new Map([[w.metaAdId, "adset-parent-1"]]),
      budgets: new Map([["adset-parent-1", 20_000]]),
      fatigueByAdsetId: new Map([["adset-parent-1", FATIGUE_REPLENISH_THRESHOLD + 0.1]]),
      currentTestCohortSize: 1,
      cohortTargetCount: 2,
      readyToTest: [
        { ad_campaign_id: "cmp-1", archetype: null, lander_url: "https://x1", status: "ready_no_active_ad", formats: [], created_at: "" },
      ],
    }),
  );
  const rows = buildShadowActivityRows(plan);
  // One row per plan action across all four verbs — the audit trail shows the
  // complete proposed set, not a summary.
  assert.equal(rows.length, plan.promote.length + plan.kill.length + plan.replenish.length + plan.fatigueReplenish.length);
  assert.equal(rows.filter((r) => r.actionKind === "media_buyer_promoted_winner_shadow").length, plan.promote.length);
  assert.equal(rows.filter((r) => r.actionKind === "media_buyer_paused_loser_shadow").length, plan.kill.length);
  assert.equal(rows.filter((r) => r.actionKind === "media_buyer_replenished_test_cohort_shadow").length, plan.replenish.length);
  assert.equal(rows.filter((r) => r.actionKind === "media_buyer_fatigue_replenish_triggered_shadow").length, plan.fatigueReplenish.length);
  for (const r of rows) {
    assert.equal(r.metadata.mode, "shadow");
    assert.ok(r.metadata.plan_action, "every shadow row carries the plan_action JSON");
  }
});

// ── Product-scoped test rail (media-buyer-product-scoped-test-rail Phase 2) ──

// A small fake admin scoped to what readCurrentTestCohortSize + listReadyToTest
// need — `ad_publish_jobs`, `ad_campaigns`, `ad_videos` with eq / in / not
// chainable filters, then `then()` resolving to the filtered set. Mirrors the
// shape used in publish-gate.test.ts so this file stays consistent.
type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
interface Filter {
  kind: "eq" | "in" | "not_is_null";
  col: string;
  val?: unknown;
  vals?: unknown[];
}
function matchesJoined(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    const v = row[f.col];
    if (f.kind === "eq" && v !== f.val) return false;
    if (f.kind === "in" && !(f.vals ?? []).includes(v)) return false;
    if (f.kind === "not_is_null" && (v === null || v === undefined)) return false;
  }
  return true;
}
function makeFakeAdminForProductScope(tables: Tables) {
  function chain(table: string) {
    const filters: Filter[] = [];
    const resolve = () => ({
      data: (tables[table] ?? []).filter((r) => matchesJoined(r, filters)),
      error: null as null,
    });
    const c: {
      select: (...args: unknown[]) => typeof c;
      eq: (col: string, val: unknown) => typeof c;
      in: (col: string, vals: unknown[]) => typeof c;
      not: (col: string, op: string, val: unknown) => typeof c;
      then: (onFulfilled: (v: { data: Row[]; error: null }) => unknown) => Promise<unknown>;
    } = {
      select: () => c,
      eq: (col, val) => { filters.push({ kind: "eq", col, val }); return c; },
      in: (col, vals) => { filters.push({ kind: "in", col, vals }); return c; },
      not: (col, op, val) => {
        if (op === "is" && val === null) filters.push({ kind: "not_is_null", col });
        return c;
      },
      then: (onFulfilled) => Promise.resolve(resolve()).then(onFulfilled),
    };
    return c;
  }
  return {
    from(table: string) {
      return {
        select: (...a: unknown[]) => chain(table).select(...a),
        eq: (col: string, val: unknown) => chain(table).eq(col, val),
        in: (col: string, vals: unknown[]) => chain(table).in(col, vals),
        not: (col: string, op: string, val: unknown) => chain(table).not(col, op, val),
      };
    },
  } as unknown as Parameters<typeof readCurrentTestCohortSize>[0];
}

test("Phase 2 — the per-product live-test target defaults to 4 (was 3 pre-Phase-2, so each per-product cohort tests 4 fresh creatives at a time)", () => {
  assert.equal(DEFAULT_TEST_COHORT_TARGET, 4);
});

test("Phase 2 — readCurrentTestCohortSize counts only THIS product's live ad_publish_jobs (never the other product's) via ad_campaigns.product_id in the same shared Meta ad account", async () => {
  const PRODUCT_A = "prod-A";
  const PRODUCT_B = "prod-B";
  const tables: Tables = {
    ad_publish_jobs: [
      { id: "job-A1", workspace_id: WS, campaign_id: "cmp-A1", origin: "media-buyer-test", publish_active: true, publish_status: "published" },
      { id: "job-A2", workspace_id: WS, campaign_id: "cmp-A2", origin: "media-buyer-test", publish_active: true, publish_status: "published" },
      { id: "job-B1", workspace_id: WS, campaign_id: "cmp-B1", origin: "media-buyer-test", publish_active: true, publish_status: "published" },
      { id: "job-B2", workspace_id: WS, campaign_id: "cmp-B2", origin: "media-buyer-test", publish_active: true, publish_status: "published" },
      { id: "job-B3", workspace_id: WS, campaign_id: "cmp-B3", origin: "media-buyer-test", publish_active: true, publish_status: "published" },
      // A queued (not-yet-live) job for A is NOT counted — it's not `published`.
      { id: "job-A-queued", workspace_id: WS, campaign_id: "cmp-A3", origin: "media-buyer-test", publish_active: true, publish_status: "queued" },
      // A non-media-buyer origin (studio publish) is NOT counted regardless of product.
      { id: "job-studio", workspace_id: WS, campaign_id: "cmp-A4", origin: "operator", publish_active: true, publish_status: "published" },
    ],
    ad_campaigns: [
      { id: "cmp-A1", workspace_id: WS, product_id: PRODUCT_A },
      { id: "cmp-A2", workspace_id: WS, product_id: PRODUCT_A },
      { id: "cmp-A3", workspace_id: WS, product_id: PRODUCT_A },
      { id: "cmp-A4", workspace_id: WS, product_id: PRODUCT_A },
      { id: "cmp-B1", workspace_id: WS, product_id: PRODUCT_B },
      { id: "cmp-B2", workspace_id: WS, product_id: PRODUCT_B },
      { id: "cmp-B3", workspace_id: WS, product_id: PRODUCT_B },
    ],
  };
  const admin = makeFakeAdminForProductScope(tables);

  // The core cross-contamination guard: A's count is exactly A's two live jobs,
  // never gets inflated by B's three, and the queued+studio jobs are excluded.
  const sizeA = await readCurrentTestCohortSize(admin, { workspaceId: WS, productId: PRODUCT_A });
  assert.equal(sizeA, 2);

  // Symmetric — B's count is exactly B's three live jobs.
  const sizeB = await readCurrentTestCohortSize(admin, { workspaceId: WS, productId: PRODUCT_B });
  assert.equal(sizeB, 3);

  // Null-product default cohort preserves the pre-Phase-2 workspace-scoped count
  // (all 5 live media-buyer-test jobs, regardless of product) — Superfood Tabs
  // today is unaffected.
  const sizeDefault = await readCurrentTestCohortSize(admin, { workspaceId: WS, productId: null });
  assert.equal(sizeDefault, 5);
});

test("REGRESSION (2026-07-12 over-launch) — readCurrentTestCohortSize with a testMetaCampaignId counts LIVE campaign adsets ORIGIN-AGNOSTICALLY (legacy adsets count; paused/other-campaign don't), so a full cohort reads 4 not 0", async () => {
  const CAMP = "camp-coffee";
  const tables: Tables = {
    // The 4 pre-existing skeptic adsets were minted by the OLD loop → they have NO ad_publish_jobs rows.
    // The buggy ad_publish_jobs-only count returned 0 here → deficit 4-0 → replenished 4 on top → 8 live.
    ad_publish_jobs: [],
    meta_adsets: [
      { meta_adset_id: "as-v3", workspace_id: WS, meta_campaign_id: CAMP, effective_status: "ACTIVE" },
      { meta_adset_id: "as-fad", workspace_id: WS, meta_campaign_id: CAMP, effective_status: "ACTIVE" },
      { meta_adset_id: "as-taste", workspace_id: WS, meta_campaign_id: CAMP, effective_status: "ACTIVE" },
      { meta_adset_id: "as-toog", workspace_id: WS, meta_campaign_id: CAMP, effective_status: "ACTIVE" },
      { meta_adset_id: "as-paused", workspace_id: WS, meta_campaign_id: CAMP, effective_status: "PAUSED" }, // freed
      { meta_adset_id: "as-other", workspace_id: WS, meta_campaign_id: "camp-other", effective_status: "ACTIVE" }, // other product
    ],
  };
  const admin = makeFakeAdminForProductScope(tables);
  const size = await readCurrentTestCohortSize(admin, { workspaceId: WS, productId: "prod-coffee", testMetaCampaignId: CAMP });
  assert.equal(size, 4); // 4 live in CAMP; paused + other-campaign excluded → deficit vs target 4 = 0 → no over-launch
});

test("Phase 2 — listReadyToTest filtered by productId returns ONLY that product's ready campaigns (product B's ready creative is never selected for product A's replenish)", async () => {
  const PRODUCT_A = "prod-A";
  const PRODUCT_B = "prod-B";
  const tables: Tables = {
    ad_videos: [
      { campaign_id: "cmp-A1", workspace_id: WS, format: "1x1", media_kind: "video", status: "ready", static_jpg_url: null, meta: null },
      { campaign_id: "cmp-A2", workspace_id: WS, format: "9x16", media_kind: "video", status: "ready", static_jpg_url: null, meta: null },
      { campaign_id: "cmp-B1", workspace_id: WS, format: "1x1", media_kind: "video", status: "ready", static_jpg_url: null, meta: null },
    ],
    ad_campaigns: [
      { id: "cmp-A1", workspace_id: WS, product_id: PRODUCT_A, landing_url: "https://x/A1", created_at: "2026-07-10T00:00:00Z" },
      { id: "cmp-A2", workspace_id: WS, product_id: PRODUCT_A, landing_url: "https://x/A2", created_at: "2026-07-11T00:00:00Z" },
      { id: "cmp-B1", workspace_id: WS, product_id: PRODUCT_B, landing_url: "https://x/B1", created_at: "2026-07-12T00:00:00Z" },
    ],
    ad_publish_jobs: [], // nothing in flight
  };
  const admin = makeFakeAdminForProductScope(tables);

  // Product A's replenish sees ONLY A's campaigns — B's ready creative never
  // pollutes A's adset, which is exactly the anti-cross-contamination guard the
  // spec calls out.
  const forA = await listReadyToTest(admin, { workspaceId: WS, productId: PRODUCT_A });
  const idsA = forA.readyToTest.map((r) => r.ad_campaign_id).sort();
  assert.deepEqual(idsA, ["cmp-A1", "cmp-A2"]);
  for (const row of forA.readyToTest) assert.notEqual(row.ad_campaign_id, "cmp-B1");

  // Product B's replenish sees ONLY B's campaigns.
  const forB = await listReadyToTest(admin, { workspaceId: WS, productId: PRODUCT_B });
  assert.deepEqual(forB.readyToTest.map((r) => r.ad_campaign_id), ["cmp-B1"]);

  // Null-product (workspace-wide default) → no product filter, sees everything.
  const forDefault = await listReadyToTest(admin, { workspaceId: WS, productId: null });
  assert.deepEqual(forDefault.readyToTest.map((r) => r.ad_campaign_id).sort(), ["cmp-A1", "cmp-A2", "cmp-B1"]);
});

// ── media-buyer-replenish-per-product-scope Phase 1 — the Bianca-stuck pin ──
// Composes readCurrentTestCohortSize + computeMediaBuyerPlan + listReadyToTest
// against the exact real-world state that stalls Bianca today: Superfood Tabs's
// per-test cohort is at 2/4 live (2 ACTIVE ad sets in its testing campaign)
// while the WORKSPACE carries 25 other-product active ad sets in other testing
// campaigns and 9 P-scoped ready-to-test ad_campaigns wait in the bin. The
// pre-fix workspace-wide count computed deficit = 4 − 25 = 0 and replenish
// never fired for any product; the per-cohort count computes deficit = 4 − 2
// = 2 and picks the top 2 of P's ready bin.
test("Phase 1 pin — cohort P has 2/4 live in its testing campaign against 25 workspace-wide live in OTHER campaigns → deficit = 4-2 = 2 (not 4-25 = 0), ready bin is P-scoped, plan replenishes 2 as per-test ad sets", async () => {
  const PRODUCT_P = "prod-tabs";
  const CAMP_P = "camp-tabs"; // P's own testing campaign
  const otherAdsets = Array.from({ length: 25 }, (_, i) => ({
    meta_adset_id: `as-other-${i + 1}`,
    workspace_id: WS,
    // 5 different OTHER-product testing campaigns × 5 live ad sets each = 25 across the workspace.
    meta_campaign_id: `camp-other-${(i % 5) + 1}`,
    effective_status: "ACTIVE",
  }));
  const readyRows = Array.from({ length: 9 }, (_, i) => ({
    id: `cmp-P-r${i + 1}`,
    workspace_id: WS,
    product_id: PRODUCT_P,
    landing_url: `https://x/P/r${i + 1}`,
    // Older rows first so the plan's slice(0, deficit) picks the newest two (ready-to-test sorts DESC).
    created_at: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
  }));
  const tables: Tables = {
    meta_adsets: [
      // P's cohort: exactly 2 ACTIVE ad sets in P's testing campaign.
      { meta_adset_id: "as-P1", workspace_id: WS, meta_campaign_id: CAMP_P, effective_status: "ACTIVE" },
      { meta_adset_id: "as-P2", workspace_id: WS, meta_campaign_id: CAMP_P, effective_status: "ACTIVE" },
      // 25 ACTIVE ad sets across OTHER products' testing campaigns.
      ...otherAdsets,
    ],
    // Ready-to-test video rows for each of P's 9 waiting campaigns.
    ad_videos: readyRows.map((r) => ({
      campaign_id: r.id,
      workspace_id: WS,
      format: "1x1",
      media_kind: "video",
      status: "ready",
      static_jpg_url: null,
      meta: null,
    })),
    // Plus one OTHER product's ready row to prove listReadyToTest with productId=P excludes it.
    ad_campaigns: [
      ...readyRows,
      { id: "cmp-other-r1", workspace_id: WS, product_id: "prod-other", landing_url: "https://x/other/r1", created_at: "2026-07-15T00:00:00Z" },
    ],
    ad_publish_jobs: [], // nothing in-flight in the ready-to-test bin
  };
  // Add the other product's ad_videos row so it's also a candidate for the workspace-wide read below.
  (tables.ad_videos as Row[]).push({
    campaign_id: "cmp-other-r1",
    workspace_id: WS,
    format: "1x1",
    media_kind: "video",
    status: "ready",
    static_jpg_url: null,
    meta: null,
  });
  const admin = makeFakeAdminForProductScope(tables);

  // ── 1. Per-cohort live count: 2 in CAMP_P, NOT 25 (workspace-wide) and NOT 27 (both) ──
  const currentTestCohortSize = await readCurrentTestCohortSize(admin, {
    workspaceId: WS,
    productId: PRODUCT_P,
    testMetaCampaignId: CAMP_P,
  });
  assert.equal(currentTestCohortSize, 2, "cohort count must scope to CAMP_P's ACTIVE ad sets — 25 other-campaign live must NEVER inflate the count");

  // ── 2. P-scoped ready bin: only P's 9 ready campaigns, never the other product's row ──
  const readyForP = await listReadyToTest(admin, { workspaceId: WS, productId: PRODUCT_P });
  const readyIdsP = readyForP.readyToTest.map((r) => r.ad_campaign_id).sort();
  assert.deepEqual(readyIdsP, readyRows.map((r) => r.id).sort(), "listReadyToTest with productId=P must return exactly P's 9 ready ad_campaigns");
  for (const row of readyForP.readyToTest) assert.notEqual(row.ad_campaign_id, "cmp-other-r1", "the other product's ready ad_campaign must never leak into P's replenish bin");

  // ── 3. computeMediaBuyerPlan closes the loop: deficit = 4 − 2 = 2, replenishes the top 2 P rows ──
  const perTestCohort = cohort({
    productId: PRODUCT_P,
    adsetPerTest: true,
    testMetaAdsetId: null,
    testMetaCampaignId: CAMP_P,
    perTestDailyBudgetCents: 15_000, // $150
    dailyTestCeilingCents: 60_000, // $600 → derived target = 4 (matches DEFAULT_TEST_COHORT_TARGET)
  });
  const plan = computeMediaBuyerPlan(
    baseInputs({
      cohort: perTestCohort,
      currentTestCohortSize,
      readyToTest: readyForP.readyToTest,
    }),
  );
  assert.equal(plan.cohortTargetCount, 4, "per-test cohort target must derive to 4 at $600/$150 (aligned with DEFAULT_TEST_COHORT_TARGET + MAX_ACTIVE_TESTS_PER_CAMPAIGN)");
  assert.equal(plan.currentTestCohortSize, 2, "the plan carries the cohort-scoped live count, not the workspace-wide 25");
  assert.equal(plan.replenish.length, 2, "deficit must be 4 − 2 = 2 (NOT 4 − 25 = 0) so the ready bin actually gets drained");
  for (const r of plan.replenish) {
    // Per-test cohort: each replenish will mint a fresh $150 ad set at publish time in CAMP_P,
    // NEVER the legacy shared adset (which is null in the per-product model).
    assert.equal(r.adsetPerTest, true, "replenish must route down the per-test-adset path");
    assert.equal(r.testMetaAdsetId, null, "per-test replenish never targets the legacy shared adset");
    assert.ok(r.rationale.includes("2/4 live"), "the rationale cites the cohort-scoped count, not the workspace-wide count");
  }
});

// ── Phase 3 — (account × product) fan-out dispatcher ────────────────────────

test("Phase 3 — readActiveCohortProductIds enumerates one entry per active (account, product) cohort: TWO products in one shared account produce TWO passes with the correct productIds (Amazing Coffee + Creamer's shape)", async () => {
  const PRODUCT_COFFEE = "prod-coffee";
  const PRODUCT_CREAMER = "prod-creamer";
  const ACCT_SHARED = "acct-shared";
  const ACCT_OTHER = "acct-other";
  const tables: Tables = {
    media_buyer_test_cohorts: [
      // Shared account with two per-product cohorts + one dormant (inactive)
      // row that MUST NOT show up in the dispatch list.
      { id: "coh-coffee", workspace_id: WS, meta_ad_account_id: ACCT_SHARED, product_id: PRODUCT_COFFEE, is_active: true },
      { id: "coh-creamer", workspace_id: WS, meta_ad_account_id: ACCT_SHARED, product_id: PRODUCT_CREAMER, is_active: true },
      { id: "coh-retired", workspace_id: WS, meta_ad_account_id: ACCT_SHARED, product_id: "prod-retired", is_active: false },
      // A different account, must NOT appear in ACCT_SHARED's enumeration.
      { id: "coh-other", workspace_id: WS, meta_ad_account_id: ACCT_OTHER, product_id: null, is_active: true },
    ],
  };
  const admin = makeFakeAdminForProductScope(tables);

  const pids = await readActiveCohortProductIds(admin, {
    workspaceId: WS,
    metaAdAccountId: ACCT_SHARED,
  });
  // The core "one pass per active (account, product) cohort" guarantee: exactly
  // two entries, one per product. The dispatcher iterates this list and calls
  // runMediaBuyerLoop with each productId — a shared account fans out to both
  // products cleanly (Amazing Coffee + Creamer both get a pass this cadence).
  assert.equal(pids.length, 2, `expected 2 passes for the shared account, got ${pids.length}`);
  const set = new Set(pids);
  assert.ok(set.has(PRODUCT_COFFEE), "product Coffee's pass must be enumerated");
  assert.ok(set.has(PRODUCT_CREAMER), "product Creamer's pass must be enumerated");
  // The retired (is_active=false) cohort MUST NOT be enumerated — the dormant
  // row's audit trail survives but the dispatch treats it identically to "no row".
  assert.ok(!set.has("prod-retired"), "an inactive cohort must NOT dispatch a pass");
  // Deterministic ordering: sorted product ids ascending (nulls last).
  assert.deepEqual([...pids].sort(), pids);
});

test("Phase 3 — readActiveCohortProductIds returns the null-product default for Superfood Tabs's single-product setup (one pass, productId=null — preserves the pre-Phase-2 shape)", async () => {
  const ACCT_TABS = "acct-tabs";
  const tables: Tables = {
    media_buyer_test_cohorts: [
      { id: "coh-tabs", workspace_id: WS, meta_ad_account_id: ACCT_TABS, product_id: null, is_active: true },
    ],
  };
  const admin = makeFakeAdminForProductScope(tables);
  const pids = await readActiveCohortProductIds(admin, { workspaceId: WS, metaAdAccountId: ACCT_TABS });
  assert.deepEqual(pids, [null]);
});

test("Phase 3 — readActiveCohortProductIds mixed shape (null-product default + one per-product) fans out to both — null cohort ordered LAST (Superfood Tabs's shape when Coffee spins up in the same account)", async () => {
  const PRODUCT_COFFEE = "prod-coffee";
  const ACCT = "acct-mix";
  const tables: Tables = {
    media_buyer_test_cohorts: [
      { id: "coh-default", workspace_id: WS, meta_ad_account_id: ACCT, product_id: null, is_active: true },
      { id: "coh-coffee", workspace_id: WS, meta_ad_account_id: ACCT, product_id: PRODUCT_COFFEE, is_active: true },
    ],
  };
  const admin = makeFakeAdminForProductScope(tables);
  const pids = await readActiveCohortProductIds(admin, { workspaceId: WS, metaAdAccountId: ACCT });
  assert.deepEqual(pids, [PRODUCT_COFFEE, null]);
});

test("Phase 3 — readActiveCohortProductIds with NO active cohort for the account STILL returns [null] so the dispatcher runs one pass (dormant heartbeat emits — the lane never silently no-ops)", async () => {
  const admin = makeFakeAdminForProductScope({ media_buyer_test_cohorts: [] });
  const pids = await readActiveCohortProductIds(admin, {
    workspaceId: WS,
    metaAdAccountId: "acct-unconfigured",
  });
  assert.deepEqual(pids, [null]);
});

test("agent.ts — Phase 3 dispatcher (runMediaBuyerLoopForAccount) iterates readActiveCohortProductIds and calls runMediaBuyerLoop per productId (structural pin: a stray edit that drops the loop or the productId argument regresses to the product-blind pre-Phase-3 shape)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./agent.ts", import.meta.url), "utf8");

  // The dispatcher exists.
  assert.ok(
    /export async function runMediaBuyerLoopForAccount/.test(src),
    "runMediaBuyerLoopForAccount must exist — the box worker's media-buyer lane depends on it",
  );
  // It enumerates cohorts via the pure helper the tests above cover.
  assert.ok(
    /await readActiveCohortProductIds\(admin, \{[\s\S]*?workspaceId: opts\.workspaceId/.test(src),
    "runMediaBuyerLoopForAccount must call readActiveCohortProductIds with opts.workspaceId + opts.metaAdAccountId — otherwise the fan-out enumeration slips",
  );
  // For each enumerated productId it invokes the runner with that productId
  // spread onto the options — this is the "one pass per (account, product)"
  // contract the spec's Phase 3 verification names.
  assert.ok(
    /for \(const productId of productIds\)[\s\S]*?runMediaBuyerLoop\(admin, \{ \.\.\.opts, productId \}\)/.test(src),
    "runMediaBuyerLoopForAccount must call runMediaBuyerLoop({...opts, productId}) inside a loop over the enumerated productIds — no per-product pass without this",
  );
});

test("agent.ts — Phase 3 replenish path uses the product-scoped listReadyToTest — the pre-Phase-2 product-blind `listReadyToTest(admin, { workspaceId: opts.workspaceId })` is gone (grep guard: any regression to it is what the spec's cross-contamination guard forbids)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./agent.ts", import.meta.url), "utf8");

  // The product-scoped call is the ONE the runner uses now — it MUST be present.
  assert.ok(
    /listReadyToTest\(admin, \{\s*workspaceId: opts\.workspaceId,\s*productId: cohortProductId,?\s*\}\)/.test(src),
    "runMediaBuyerLoop must call listReadyToTest with { workspaceId, productId: cohortProductId } — that's the product-scoped read",
  );

  // The product-blind Phase-1 shape (`listReadyToTest(admin, { workspaceId })`
  // with no productId property) must be gone from the replenish path. Match a
  // fenced literal so a call that later adds productId still passes.
  const blindPattern = /listReadyToTest\s*\(\s*admin\s*,\s*\{\s*workspaceId(?:\s*:\s*[^,}]+)?\s*\}\s*\)/g;
  const matches = src.match(blindPattern) ?? [];
  assert.equal(
    matches.length,
    0,
    `agent.ts still contains ${matches.length} product-blind listReadyToTest call(s): ${JSON.stringify(matches)} — the Phase 3 spec verification's grep guard forbids this. Add productId to every call.`,
  );
});

// Structural guard on the runner branch predicate — the shadow-mode carve-out is
// the ONE call site that shapes the "armed still writes iteration_actions +
// ad_publish_jobs" invariant Phase 2 promises. If the branch condition drifts (a
// stray edit removes the mode check, or the shadow path leaks into armed) this
// pin catches it before merge instead of at runtime.
test("agent.ts — runMediaBuyerLoop shadow branch is gated on policy.mode === 'shadow' (armed skips it)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./agent.ts", import.meta.url), "utf8");
  assert.ok(
    src.includes('if (policy.mode === "shadow")'),
    "runMediaBuyerLoop must guard the shadow branch on `policy.mode === \"shadow\"` — armed policies must fall through to the executor writes",
  );
  assert.ok(
    src.includes("buildShadowActivityRows(plan)"),
    "shadow branch must build director_activity rows via the pure buildShadowActivityRows helper (the tested surface)",
  );
});

// ── resolveReplenishAdCopy — fail-closed guard (empty-copy → malformed Meta creative) ────────────────
// Regression for the 2026-07-12 defect: enqueueReplenishPublish hard-coded headlines:[]/primary_texts:[],
// so ad-tool built an asset_feed_spec with empty titles[]/bodies[] and Meta rejected every replenish publish
// with meta_400 "The link field is required." The guard must POPULATE copy from the angle and FAIL CLOSED
// when it's absent.

test("resolveReplenishAdCopy: angle with headline + primary_text → ok, populated arrays", () => {
  const r = resolveReplenishAdCopy({ meta_headline: "Sleep better tonight", meta_primary_text: "Our gummies help you fall asleep faster." });
  assert.equal(r.ok, true);
  assert.deepEqual(r.headlines, ["Sleep better tonight"]);
  assert.deepEqual(r.primaryTexts, ["Our gummies help you fall asleep faster."]);
  assert.equal(r.reason, null);
});

test("resolveReplenishAdCopy: null angle (no angle_id) → NOT ok, fail closed", () => {
  const r = resolveReplenishAdCopy(null);
  assert.equal(r.ok, false);
  assert.deepEqual(r.headlines, []);
  assert.deepEqual(r.primaryTexts, []);
  assert.ok(r.reason && r.reason.length > 0);
});

test("resolveReplenishAdCopy: headline present but primary_text empty → NOT ok (both required)", () => {
  const r = resolveReplenishAdCopy({ meta_headline: "Sleep better", meta_primary_text: "" });
  assert.equal(r.ok, false);
});

test("resolveReplenishAdCopy: primary_text present but headline null → NOT ok (both required)", () => {
  const r = resolveReplenishAdCopy({ meta_headline: null, meta_primary_text: "Real copy here." });
  assert.equal(r.ok, false);
});

test("resolveReplenishAdCopy: whitespace-only copy is treated as empty → NOT ok", () => {
  const r = resolveReplenishAdCopy({ meta_headline: "   ", meta_primary_text: "  \n " });
  assert.equal(r.ok, false);
  assert.deepEqual(r.headlines, []);
});
