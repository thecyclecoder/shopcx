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
  SENSOR_TRUST_MAX_AGE_MS,
  type MediaBuyerLoser,
  type MediaBuyerPlanInputs,
  type SensorTrustSnapshot,
} from "./agent";
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
