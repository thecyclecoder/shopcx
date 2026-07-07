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
  computeMediaBuyerPlan,
  DEFAULT_FATIGUE_REPLENISH_VARIANTS,
  DEFAULT_TEST_COHORT_TARGET,
  FATIGUE_REPLENISH_THRESHOLD,
  type MediaBuyerLoser,
  type MediaBuyerPlanInputs,
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
    ...overrides,
  };
}

function cohort(overrides: Partial<MediaBuyerTestCohort> = {}): MediaBuyerTestCohort {
  return {
    id: "cohort-1",
    workspaceId: WS,
    metaAdAccountId: null,
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
