/**
 * Media Buyer agent — the weekly Test→Measure→Promote→Kill cadence
 * (media-buyer-test-winner-loop Phase 2).
 *
 * The Growth director's autonomous static-ad optimizer, mirrored onto the box's
 * agent-lane pattern (read-only reasoning; deterministic worker writes). Per
 * cadence pass it:
 *
 *   1) MEASURES — reads [[../ads/winning-creative-detect]] `detectWinners` over
 *      the recalibrated attribution (attribution-sensor-recalibration Phase 2),
 *      and reads adset-grain scorecards for LOSERS below the active policy's
 *      `roas_floor` × 1.0 (no margin — the policy's floor is authoritative).
 *   2) PROMOTES — for each winner past the min-spend + ROAS floor, proposes a
 *      `scale_up` at the winner's adset grain, sized by the active policy's
 *      `scale_up_step_pct`, capped by `scale_up_cap_pct`. Persisted to
 *      [[../meta/execution]] via `iteration_actions` at `status='decided'` so the
 *      existing executor picks it up on its next pass — the AGENT never writes
 *      Meta objects (north star: proxy-owner supervises the tool; the tool moves
 *      dollars only via the sanctioned executor).
 *   3) KILLS — for each loser adset with cost past `pause_min_spend_cents`,
 *      proposes a `pause` action (same iteration_actions ledger).
 *   4) REPLENISHES — tops the test cohort back up to N fresh creatives by
 *      publishing ready-to-test campaigns ([[../ads/ready-to-test]]) LIVE into
 *      the configured test ad set via [[./publish-gate]]'s `origin='media-buyer-test'`
 *      rail — Phase 1 does the actual gating (adset match + under-ceiling).
 *
 * Every promote / kill / replenish stamps a [[../director-activity]] row
 * (`director_function='growth'`) carrying the source `meta_ad_id` + realized
 * ROAS + rationale so the audit trail cites concrete numbers, not narrative.
 *
 * With NO active [[../iteration-policy-authoring]] row, the loop REFUSES to
 * autonomously promote/kill (records `media_buyer_no_active_policy` + returns
 * an empty plan). The Media Buyer is dormant until the Growth director (or a
 * human) authors + activates a conservative policy — the exact rail Phase 2's
 * spec verification calls out ("with an active iteration_policies row present,
 * the decision engine returns a non-empty action set …").
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { recordDirectorActivity } from "@/lib/director-activity";
import { detectWinners, amplifyWinner, type DetectedWinner } from "@/lib/ads/winning-creative-detect";
import { detectMetaCpaWinners, detectMetaCpaLosers, detectMetaCpaReactivations, hasFreshMetaSignal, META_SIGNAL_MAX_AGE_DAYS, type MetaCpaReactivation } from "@/lib/media-buyer/meta-cpa-signal";
import { stampCreativeOutcome } from "@/lib/ads/creative-learning";
import { listReadyToTest, type ReadyToTestRow } from "@/lib/ads/ready-to-test";
import { loadActivePolicy, type IterationPolicy } from "@/lib/meta/decision-engine";
import { getEffectiveMediaBuyerTestCohort, MEDIA_BUYER_TEST_ORIGIN, type MediaBuyerTestCohort, type CreateAdsetSpec } from "@/lib/media-buyer/publish-gate";
import { maxConcurrentTests } from "@/lib/media-buyer/provision-cohort";
import { inngest } from "@/lib/inngest/client";

type Admin = ReturnType<typeof createAdminClient>;

const GROWTH_DIRECTOR_FUNCTION = "growth";

/**
 * Default number of live creatives the Media Buyer keeps in the test cohort at any time.
 *
 * [[../../../docs/brain/specs/media-buyer-product-scoped-test-rail]] Phase 2 —
 * raised 3 → 4 to give each PER-PRODUCT cohort its own 4-live-test target. The
 * count is now scoped by `ad_campaigns.product_id` (see `readCurrentTestCohortSize`),
 * so a shared Meta ad account carries 4 live tests per product, not one shared
 * budget/topline across two products in the same account.
 */
export const DEFAULT_TEST_COHORT_TARGET = 4;

/**
 * media-buyer-sensor-trust-probe Phase 3 — the freshness cap on a sensor-trust snapshot.
 * A snapshot whose `created_at` is older than this is treated as untrusted (`stale_snapshot`
 * added to the reasons + the same denied path fires) — "stale trust ≡ untrusted", per the
 * spec's verification (a 72h-stale snapshot must deny the pass). Measured from `created_at`
 * (row-insertion time), not `snapshot_date` (a date bucket), so a day-late probe run doesn't
 * silently keep the pass alive on cold data.
 */
export const SENSOR_TRUST_MAX_AGE_MS = 48 * 3600_000;

/** The trimmed row shape the pure gate consumes — mirrors the SELECT the runner does. */
export interface SensorTrustSnapshot {
  snapshot_date: string;
  band: string | null;
  coverage_ratio: number | null;
  reasons: string[] | null;
  created_at: string;
}

/** The verdict the pure gate emits when it denies a pass. */
export interface SensorTrustDenial {
  reason: string;
  snapshot_date: string | null;
  band: string | null;
  coverage_ratio: number | null;
  reasons: string[];
}

/**
 * Pure — decide whether the latest sensor-trust snapshot lets the Media Buyer pass proceed.
 * Returns a `SensorTrustDenial` for any failing check (missing / stale / red-band); returns
 * `null` when the snapshot clears all three gates. The `reasons` field on a denial carries
 * the snapshot's own reasons plus any freshness signal we add (`missing_snapshot` when the
 * row itself is absent, `stale_snapshot` when the age cap trips) so downstream can distinguish.
 *
 * Gate order:
 *   1) present — a null snapshot deny with `missing_snapshot` reason.
 *   2) fresh — `nowMs - created_at ≤ SENSOR_TRUST_MAX_AGE_MS` (48h). Stale ≡ untrusted.
 *   3) band !== 'red' — a red band is the probe's explicit "sensor untrusted" verdict.
 * A green OR yellow band that is fresh clears the gate — yellow is a warning the probe
 * carries via its own reasons (unresolved-share nearing cap, thin spend allocation), not a
 * refusal; only red short-circuits the pass.
 */
export function evaluateSensorTrustSnapshot(
  snapshot: SensorTrustSnapshot | null,
  nowMs: number,
): SensorTrustDenial | null {
  if (!snapshot) {
    return {
      reason: "no media_buyer_sensor_trust snapshot for this workspace/account — run the sensor-trust-probe lane first.",
      snapshot_date: null,
      band: null,
      coverage_ratio: null,
      reasons: ["missing_snapshot"],
    };
  }
  const existingReasons = Array.isArray(snapshot.reasons) ? snapshot.reasons : [];
  const createdMs = new Date(snapshot.created_at).getTime();
  const ageMs = Number.isFinite(createdMs) ? nowMs - createdMs : Number.POSITIVE_INFINITY;
  if (ageMs > SENSOR_TRUST_MAX_AGE_MS) {
    const ageH = Math.max(0, Math.round(ageMs / 3600_000));
    return {
      reason: `sensor-trust snapshot is stale — ${ageH}h old (cap ${SENSOR_TRUST_MAX_AGE_MS / 3600_000}h). Stale trust ≡ untrusted.`,
      snapshot_date: snapshot.snapshot_date,
      band: snapshot.band,
      coverage_ratio: snapshot.coverage_ratio,
      reasons: [...existingReasons, "stale_snapshot"],
    };
  }
  if (snapshot.band === "red") {
    return {
      reason: `sensor-trust band=red — attribution untrusted; refusing to grade Media Buyer calls until the probe recovers.`,
      snapshot_date: snapshot.snapshot_date,
      band: snapshot.band,
      coverage_ratio: snapshot.coverage_ratio,
      reasons: existingReasons,
    };
  }
  return null;
}

/**
 * Read the newest `media_buyer_sensor_trust` snapshot for a workspace + optional account
 * (order by snapshot_date desc, limit 1). Returns `null` when no row exists. The account
 * filter mirrors the probe's write path — a per-account probe row is preferred over a
 * workspace-wide one; a null-account caller reads only the null-account row.
 */
async function readLatestSensorTrust(
  admin: Admin,
  workspaceId: string,
  metaAdAccountId: string | null,
): Promise<SensorTrustSnapshot | null> {
  const base = admin
    .from("media_buyer_sensor_trust")
    .select("snapshot_date, band, coverage_ratio, reasons, created_at")
    .eq("workspace_id", workspaceId)
    .order("snapshot_date", { ascending: false })
    .limit(1);
  const { data, error } = metaAdAccountId
    ? await base.eq("meta_ad_account_id", metaAdAccountId).maybeSingle()
    : await base.is("meta_ad_account_id", null).maybeSingle();
  if (error || !data) return null;
  const row = data as {
    snapshot_date: string;
    band: string | null;
    coverage_ratio: number | null;
    reasons: unknown;
    created_at: string;
  };
  return {
    snapshot_date: row.snapshot_date,
    band: row.band,
    coverage_ratio: row.coverage_ratio,
    reasons: Array.isArray(row.reasons) ? (row.reasons as string[]) : null,
    created_at: row.created_at,
  };
}

/**
 * Build the dormant plan shape the pass returns when the sensor-trust gate denies —
 * mirrors the no-active-policy dormancy shape (0 promote/kill/replenish, empty summary
 * naming the denial reason). Kept in one place so the two dormancy paths stay in sync.
 */
function buildSensorTrustDormantPlan(
  denial: SensorTrustDenial,
  cohortTargetCount: number,
): MediaBuyerPlan {
  return {
    policyActive: false,
    policyVersionId: null,
    cohortConfigured: false,
    cohortTargetCount,
    currentTestCohortSize: 0,
    promote: [],
    kill: [],
    replenish: [],
    fatigueReplenish: [],
    summary: `Dormant: sensor-trust denied — ${denial.reason}`,
  };
}

/** A promote action — scale up the winner's parent Meta adset via the executor. */
export interface MediaBuyerPromoteAction {
  kind: "promote";
  sourceMetaAdId: string;
  roas: number;
  spendCents: number;
  targetLevel: "adset" | "campaign";
  /** The Meta id of the object the executor scales. */
  targetObjectId: string;
  beforeBudgetCents: number | null;
  afterBudgetCents: number | null;
  rationale: string;
  policyVersionId: string;
  /** The `ad_campaigns.id` (our uuid) the winner rolls up to — for cross-linking. */
  sourceAdCampaignId: string | null;
}

/** A kill action — pause the losing Meta object via the executor. */
export interface MediaBuyerKillAction {
  kind: "kill";
  sourceMetaAdId: string;
  roas: number;
  spendCents: number;
  targetLevel: "adset" | "campaign";
  targetObjectId: string;
  rationale: string;
  policyVersionId: string;
}

/** A replenish action — publish a ready-to-test campaign live into the test cohort. */
export interface MediaBuyerReplenishAction {
  kind: "replenish";
  adCampaignId: string;
  /** Legacy shared-adset mode: the [[media_buyer_test_cohorts]] `test_meta_adset_id` we publish INTO.
   * NULL in per-test mode (`adsetPerTest`) — a fresh $150 ad set is minted at publish time. */
  testMetaAdsetId: string | null;
  /** Per-test mode: the publisher mints a dedicated $150 ad set from this cohort marker (the enqueue
   * assembles the concrete `create_adset_spec` — this flag routes the enqueue down that path). */
  adsetPerTest: boolean;
  /** The cohort ceiling we pin the ad set's daily budget to. */
  dailyTestCeilingCents: number;
  rationale: string;
}

/**
 * Phase 3 fatigue-triggered replenish — spawn N fresh variants of a WINNING angle
 * when its parent adset's fatigue signal crosses the threshold. Enqueues via
 * [[../ads/winning-creative-detect]] `amplifyWinner`, respecting its per-day cap.
 * The variants land as `ad_campaigns` at `status='ready'` — the standard replenish
 * path picks them up on the next pass and publishes them live into the test cohort.
 */
export interface MediaBuyerFatigueReplenishAction {
  kind: "fatigue_replenish";
  sourceMetaAdId: string;
  roas: number;
  fatigueScore: number;
  /** How many variants the plan wants (clamped by `MAX_VARIANTS_PER_WINNER` inside amplifyWinner). */
  variantCount: number;
  rationale: string;
  policyVersionId: string;
  sourceAdCampaignId: string | null;
}

/** The typed plan the runner emits — one pass, one workspace. */
export interface MediaBuyerPlan {
  /** True iff an active iteration_policies row was found. */
  policyActive: boolean;
  policyVersionId: string | null;
  /** True iff an active media_buyer_test_cohorts row was found. */
  cohortConfigured: boolean;
  cohortTargetCount: number;
  currentTestCohortSize: number;
  promote: MediaBuyerPromoteAction[];
  kill: MediaBuyerKillAction[];
  replenish: MediaBuyerReplenishAction[];
  /** Phase 3 — winners flagged as fatiguing that need their angle amplified. */
  fatigueReplenish: MediaBuyerFatigueReplenishAction[];
  summary: string;
}

/** A loser input row — a low-ROAS scorecard adset the plan may kill. */
export interface MediaBuyerLoser {
  /** The ad-grain `meta_ad_id` we cite in the audit trail (source of the bad ROAS). */
  sourceMetaAdId: string;
  /** The adset/campaign level the executor pauses. */
  targetLevel: "adset" | "campaign";
  targetObjectId: string;
  roas: number;
  spendCents: number;
  triggeringScorecardId: string;
}

// ── Shadow-mode persistence (media-buyer-shadow-mode Phase 2) ────────────────

/**
 * One director_activity row the runner writes in shadow mode. Emitted 1:1 per
 * plan action — verb `<verb>_shadow` (`media_buyer_promoted_winner_shadow`,
 * `media_buyer_paused_loser_shadow`, `media_buyer_replenished_test_cohort_shadow`,
 * `media_buyer_fatigue_replenish_triggered_shadow`) — carrying `metadata.mode='shadow'`
 * + the full `plan_action` JSON so a human reviewer can concur/dissent against the
 * complete proposal, not a paraphrase.
 */
export interface ShadowActivityRow {
  actionKind:
    | "media_buyer_promoted_winner_shadow"
    | "media_buyer_paused_loser_shadow"
    | "media_buyer_replenished_test_cohort_shadow"
    | "media_buyer_fatigue_replenish_triggered_shadow";
  reason: string;
  metadata: Record<string, unknown>;
}

/**
 * Pure — build the shadow-mode director_activity rows for a computed plan. Emits ONE
 * row per plan action across the four verbs (promote / kill / replenish / fatigue_replenish)
 * so a human reviewer sees the exact same set of proposed moves the armed executor would
 * make — minus the actual iteration_actions / ad_publish_jobs writes. The runner writes
 * these via `recordDirectorActivity` on the `growth` director-function AND ALSO writes a
 * `media_buyer_pass_completed` heartbeat with `metadata.mode='shadow'` so the audit trail
 * shows a shadow pass even when the plan is empty.
 *
 * Every row carries `metadata.mode='shadow'` + `metadata.plan_action=<action JSON>`
 * (the CEO-facing citation contract) plus the canonical `source_meta_ad_id`, `roas`, and
 * `policy_version_id` fields — same shape the armed director_activity rows use, so a
 * later "flip to armed" comparison stays apples-to-apples.
 */
export function buildShadowActivityRows(plan: MediaBuyerPlan): ShadowActivityRow[] {
  const rows: ShadowActivityRow[] = [];
  for (const a of plan.promote) {
    rows.push({
      actionKind: "media_buyer_promoted_winner_shadow",
      reason: a.rationale,
      metadata: {
        mode: "shadow",
        plan_action: a,
        source_meta_ad_id: a.sourceMetaAdId,
        roas: a.roas,
        policy_version_id: a.policyVersionId,
        autonomous: true,
      },
    });
  }
  for (const a of plan.kill) {
    rows.push({
      actionKind: "media_buyer_paused_loser_shadow",
      reason: a.rationale,
      metadata: {
        mode: "shadow",
        plan_action: a,
        source_meta_ad_id: a.sourceMetaAdId,
        roas: a.roas,
        policy_version_id: a.policyVersionId,
        autonomous: true,
      },
    });
  }
  for (const a of plan.replenish) {
    rows.push({
      actionKind: "media_buyer_replenished_test_cohort_shadow",
      reason: a.rationale,
      metadata: {
        mode: "shadow",
        plan_action: a,
        policy_version_id: plan.policyVersionId,
        autonomous: true,
      },
    });
  }
  for (const a of plan.fatigueReplenish) {
    rows.push({
      actionKind: "media_buyer_fatigue_replenish_triggered_shadow",
      reason: a.rationale,
      metadata: {
        mode: "shadow",
        plan_action: a,
        source_meta_ad_id: a.sourceMetaAdId,
        roas: a.roas,
        policy_version_id: a.policyVersionId,
        autonomous: true,
      },
    });
  }
  return rows;
}

/** Inputs to the pure plan computer — all reads already done by the runner. */
export interface MediaBuyerPlanInputs {
  policy: IterationPolicy | null;
  cohort: MediaBuyerTestCohort | null;
  winners: DetectedWinner[];
  losers: MediaBuyerLoser[];
  /** ad-grain meta_ad_id → parent meta_adset_id (from `meta_ads`). */
  metaAdIdToAdsetId: Map<string, string>;
  /** meta_object_id → current daily_budget_cents (from `meta_adsets`/`meta_campaigns`). */
  budgets: Map<string, number | null>;
  /**
   * Phase 3 — meta_object_id → fatigue_score for each winner's parent adset (from
   * `iteration_scorecards_daily.fatigue_score`). A winner whose fatigue score is
   * past {@link FATIGUE_REPLENISH_THRESHOLD} triggers a `fatigue_replenish` action.
   * A missing entry = "no scorecard for this adset" = never flags fatigued.
   */
  fatigueByAdsetId?: Map<string, number>;
  readyToTest: ReadyToTestRow[];
  /** How many test-cohort live ads currently exist (published via origin='media-buyer-test'). */
  currentTestCohortSize: number;
  cohortTargetCount?: number;
}

/**
 * The fatigue score at/above which a winner triggers a `fatigue_replenish` action.
 * Mirrors [[../meta/decision-engine]]'s `fatigue_score >= 0.5` threshold — same
 * signal, same cutoff, so a winner that scoring calls "fatigued" for scale-up
 * suppression ALSO triggers Phase 3's variant spawn.
 */
export const FATIGUE_REPLENISH_THRESHOLD = 0.5;

/**
 * Default number of fresh variants the fatigue-replenish requests per fatiguing winner.
 * `amplifyWinner` clamps this at `MAX_VARIANTS_PER_WINNER` (4) and enforces its per-day
 * `MAX_AMPLIFICATIONS_PER_DAY` cap, so this is a soft request; the enforced ceiling wins.
 */
export const DEFAULT_FATIGUE_REPLENISH_VARIANTS = 2;

/**
 * Compute the Media Buyer plan for one pass. Pure — no DB, no Meta, no Inngest.
 * The runner passes in all reads; this function returns the typed plan.
 *
 * Returns an empty plan when no active policy exists — the loop is dormant until
 * the Growth director / a human authors + activates one.
 */
export function computeMediaBuyerPlan(input: MediaBuyerPlanInputs): MediaBuyerPlan {
  // Per-test cohorts derive the live-test target from budget math: ceiling ÷ per-test = max concurrent
  // $150 ad sets (4 at $600/$150). Legacy shared-adset cohorts use the fixed DEFAULT (or an override).
  const cohortTargetCount =
    input.cohort?.adsetPerTest
      ? maxConcurrentTests({
          daily_test_ceiling_cents: input.cohort.dailyTestCeilingCents,
          per_test_daily_budget_cents: input.cohort.perTestDailyBudgetCents,
        })
      : (input.cohortTargetCount ?? DEFAULT_TEST_COHORT_TARGET);
  const summaryParts: string[] = [];

  if (!input.policy) {
    return {
      policyActive: false,
      policyVersionId: null,
      cohortConfigured: !!input.cohort,
      cohortTargetCount,
      currentTestCohortSize: input.currentTestCohortSize,
      promote: [],
      kill: [],
      replenish: [],
      fatigueReplenish: [],
      summary:
        "Dormant: no active iteration_policies row — Media Buyer never scales/kills without a supervised policy. Author + activate a conservative policy to activate the loop.",
    };
  }
  const policy = input.policy;

  // ── Promote ────────────────────────────────────────────────────────────────
  const promote: MediaBuyerPromoteAction[] = [];
  for (const w of input.winners) {
    // Trust-Meta winners are already crowned on CPA upstream — don't re-gate on the ROAS trigger
    // (Meta first-order ROAS is below any LTV-scaled trigger for a subscription product).
    if (!policy.trust_meta_reported_signal && w.roas < policy.scale_up_roas_trigger) continue;
    const adsetId = input.metaAdIdToAdsetId.get(w.metaAdId);
    if (!adsetId) continue; // no parent adset resolved — can't scale
    const before = input.budgets.get(adsetId) ?? null;
    const stepPct = Math.min(policy.scale_up_step_pct, policy.scale_up_cap_pct);
    const after = before != null ? Math.round(before * (1 + stepPct)) : null;
    promote.push({
      kind: "promote",
      sourceMetaAdId: w.metaAdId,
      roas: w.roas,
      spendCents: w.spendCents,
      targetLevel: "adset",
      targetObjectId: adsetId,
      beforeBudgetCents: before,
      afterBudgetCents: after,
      rationale: `Promote winner: ad ${w.metaAdId} ROAS ${w.roas.toFixed(2)} ≥ scale_up_roas_trigger ${policy.scale_up_roas_trigger.toFixed(2)} (spend $${(w.spendCents / 100).toFixed(2)}); +${Math.round(stepPct * 100)}% budget on adset ${adsetId}.`,
      policyVersionId: policy.id,
      sourceAdCampaignId: w.campaign?.id ?? null,
    });
  }

  // ── Kill ───────────────────────────────────────────────────────────────────
  const kill: MediaBuyerKillAction[] = [];
  for (const l of input.losers) {
    if (l.roas >= policy.roas_floor) continue;
    if (l.spendCents < policy.pause_min_spend_cents) continue;
    if (policy.never_pause_object_ids.includes(l.targetObjectId)) continue;
    kill.push({
      kind: "kill",
      sourceMetaAdId: l.sourceMetaAdId,
      roas: l.roas,
      spendCents: l.spendCents,
      targetLevel: l.targetLevel,
      targetObjectId: l.targetObjectId,
      rationale: `Kill loser: ${l.targetLevel} ${l.targetObjectId} ROAS ${l.roas.toFixed(2)} < roas_floor ${policy.roas_floor.toFixed(2)} on $${(l.spendCents / 100).toFixed(2)} spend (≥ pause_min $${(policy.pause_min_spend_cents / 100).toFixed(2)}); source winner-ad-in-decline ${l.sourceMetaAdId}.`,
      policyVersionId: policy.id,
    });
  }

  // ── Fatigue replenish (Phase 3) ────────────────────────────────────────────
  // When a WINNING ad's parent adset is fatiguing (fatigue_score past threshold),
  // trigger amplifyWinner to spawn N fresh variants of the winning angle. Guarded
  // on the SAME fatigue cutoff decision-engine uses to suppress a scale-up so the
  // two signals stay coherent — a "too fatigued to scale further" winner IS the
  // "time to spawn fresh variants" winner.
  const fatigueReplenish: MediaBuyerFatigueReplenishAction[] = [];
  const fatigueMap = input.fatigueByAdsetId ?? new Map<string, number>();
  for (const w of input.winners) {
    if (!policy.trust_meta_reported_signal && w.roas < policy.scale_up_roas_trigger) continue; // only real winners qualify (trust-Meta already crowned on CPA)
    const adsetId = input.metaAdIdToAdsetId.get(w.metaAdId);
    if (!adsetId) continue;
    const fatigue = fatigueMap.get(adsetId);
    if (fatigue == null) continue; // no scorecard = no fatigue signal, don't fire
    if (fatigue < FATIGUE_REPLENISH_THRESHOLD) continue;
    fatigueReplenish.push({
      kind: "fatigue_replenish",
      sourceMetaAdId: w.metaAdId,
      roas: w.roas,
      fatigueScore: fatigue,
      variantCount: DEFAULT_FATIGUE_REPLENISH_VARIANTS,
      rationale: `Fatigue replenish: winner ad ${w.metaAdId} ROAS ${w.roas.toFixed(2)} on adset ${adsetId} with fatigue_score ${fatigue.toFixed(2)} ≥ threshold ${FATIGUE_REPLENISH_THRESHOLD.toFixed(2)} — spawn ${DEFAULT_FATIGUE_REPLENISH_VARIANTS} fresh variants of the winning angle via amplifyWinner (per-day cap enforced downstream).`,
      policyVersionId: policy.id,
      sourceAdCampaignId: w.campaign?.id ?? null,
    });
  }

  // ── Replenish ──────────────────────────────────────────────────────────────
  const replenish: MediaBuyerReplenishAction[] = [];
  if (input.cohort && input.cohort.isActive) {
    const deficit = Math.max(0, cohortTargetCount - input.currentTestCohortSize);
    const picks = input.readyToTest.slice(0, deficit);
    const perTest = input.cohort.adsetPerTest;
    for (const p of picks) {
      replenish.push({
        kind: "replenish",
        adCampaignId: p.ad_campaign_id,
        testMetaAdsetId: perTest ? null : input.cohort.testMetaAdsetId,
        adsetPerTest: perTest,
        dailyTestCeilingCents: input.cohort.dailyTestCeilingCents,
        rationale: perTest
          ? `Replenish test cohort (${input.currentTestCohortSize}/${cohortTargetCount} live) — minting a fresh $${(input.cohort.perTestDailyBudgetCents / 100).toFixed(0)}/day ad set in campaign ${input.cohort.testMetaCampaignId} for ready-to-test campaign ${p.ad_campaign_id} via origin='${MEDIA_BUYER_TEST_ORIGIN}'.`
          : `Replenish test cohort (${input.currentTestCohortSize}/${cohortTargetCount} live) — publishing ready-to-test campaign ${p.ad_campaign_id} into adset ${input.cohort.testMetaAdsetId} via origin='${MEDIA_BUYER_TEST_ORIGIN}'.`,
      });
    }
    if (deficit > 0 && replenish.length < deficit) {
      summaryParts.push(`replenish short: ${replenish.length}/${deficit} — ready-to-test bin exhausted`);
    }
  } else {
    summaryParts.push("cohort dormant — no active media_buyer_test_cohorts row; replenish skipped");
  }

  summaryParts.unshift(
    `promote=${promote.length} kill=${kill.length} replenish=${replenish.length} fatigue_replenish=${fatigueReplenish.length} (policy v${policy.version})`,
  );

  return {
    policyActive: true,
    policyVersionId: policy.id,
    cohortConfigured: !!input.cohort,
    cohortTargetCount,
    currentTestCohortSize: input.currentTestCohortSize,
    promote,
    kill,
    replenish,
    fatigueReplenish,
    summary: summaryParts.join(" · "),
  };
}

// ── Per-product live-test cohort size (Phase 2) ──────────────────────────────

/**
 * [[../../../docs/brain/specs/media-buyer-product-scoped-test-rail]] Phase 2 —
 * count the ACTIVE `origin='media-buyer-test'` publish jobs currently live for
 * ONE product. The runner reads `cohort.productId` and calls this; the count
 * feeds `computeMediaBuyerPlan`'s deficit calculation so each per-product cohort
 * is capped by its OWN target (default 4) and never by another product's live
 * tests in the same shared Meta ad account.
 *
 * Behaviour:
 *   • productId = <uuid> → count only jobs whose `ad_campaigns.product_id`
 *     equals this product. A shared account's product-A pass counts only A's
 *     live tests, never B's — the anti-cross-contamination guard.
 *   • productId = null → count every workspace-scoped live test job. This
 *     preserves the pre-Phase-2 shape for the null-product default cohort
 *     (Superfood Tabs today).
 *
 * Two queries: (1) enumerate live job campaign_ids; (2) filter those campaign
 * ids to the product via `ad_campaigns.product_id`. Small enough per pass; the
 * product-filter is a `.in(...)` over the live-job set, not a workspace-wide
 * scan.
 */
export async function readCurrentTestCohortSize(
  admin: Admin,
  args: { workspaceId: string; productId: string | null },
): Promise<number> {
  const { data: liveJobsRaw } = await admin
    .from("ad_publish_jobs")
    .select("id, campaign_id")
    .eq("workspace_id", args.workspaceId)
    .eq("origin", MEDIA_BUYER_TEST_ORIGIN)
    .eq("publish_active", true)
    .eq("publish_status", "published");
  const liveJobs = (liveJobsRaw ?? []) as Array<{ id: string; campaign_id: string | null }>;
  if (!args.productId) return liveJobs.length;

  const campaignIds = liveJobs
    .map((j) => j.campaign_id)
    .filter((id): id is string => !!id);
  if (!campaignIds.length) return 0;

  const { data: matchingCampaigns } = await admin
    .from("ad_campaigns")
    .select("id")
    .eq("workspace_id", args.workspaceId)
    .in("id", campaignIds)
    .eq("product_id", args.productId);
  return (matchingCampaigns ?? []).length;
}

// ── Runner orchestrator ───────────────────────────────────────────────────────

export interface RunMediaBuyerOptions {
  workspaceId: string;
  metaAdAccountId: string;
  /**
   * [[../../../docs/brain/specs/media-buyer-product-scoped-test-rail]] Phase 3 —
   * the product this pass is scoped to. The dispatcher (`runMediaBuyerLoopForAccount`)
   * enumerates every active cohort per account and calls the runner ONCE per
   * `(account, productId)` tuple — a null-product cohort runs once (the pre-Phase-2
   * shape, preserved so Superfood Tabs is untouched). Passing `productId` here:
   *   • routes the cohort read to the per-product row (per-product ceiling +
   *     adset are enforced by `getEffectiveMediaBuyerTestCohort`), and
   *   • flows into `listReadyToTest` + `readCurrentTestCohortSize` so the
   *     replenish only picks THIS product's ready creative and only counts
   *     THIS product's live tests (anti-cross-contamination core, Phase 2).
   */
  productId?: string | null;
  cohortTargetCount?: number;
  snapshotDate?: string;
  /** Override "now" — tests pin this so the winner window is deterministic. */
  nowMs?: number;
}

export interface RunMediaBuyerResult {
  plan: MediaBuyerPlan;
  writes: {
    iterationActionsInserted: number;
    directorActivityRows: number;
    publishJobsInserted: number;
    /** Phase 3 — new `ad_campaigns` rows spawned by fatigue-triggered amplifyWinner calls. */
    amplifiedAdCampaignIds: string[];
  };
}

/**
 * [[../../../docs/brain/specs/media-buyer-product-scoped-test-rail]] Phase 3 —
 * one entry per (account, product) pass the dispatcher ran. `productId` names
 * WHICH cohort was resolved (null = the account's null-product default cohort,
 * or the "no active cohort" fallback for an unconfigured account). `error` is
 * populated when the per-product pass threw so the outer lane can still see
 * every product's result without one bad product hiding the others.
 */
export interface RunMediaBuyerAccountPass {
  productId: string | null;
  result: RunMediaBuyerResult;
  error?: string;
}

/**
 * The deterministic loop the box worker's media-buyer lane runs. Reads inputs,
 * computes the plan, then PERSISTS it — the writes are the ONLY code path in the
 * loop that mutates state:
 *
 *   - `iteration_actions` rows at `status='decided'` for every promote (scale_up)
 *     and every kill (pause). The existing [[../meta/execution]] executor picks
 *     these up and applies them to Meta on its next pass — the media-buyer NEVER
 *     calls `updateObjectStatus` / `updateObjectBudget` directly.
 *   - `director_activity` rows: one per plan action + one summary row for the
 *     pass (`media_buyer_pass_completed` — the audit heartbeat).
 *   - `ad_publish_jobs` rows for every replenish, at `publish_active=true`,
 *     `origin='media-buyer-test'` — the Phase 1 gate on the route / publisher
 *     decides whether the ad actually ships ACTIVE, and Phase 1's belt-and-
 *     suspenders escalates any rail hit.
 */
export async function runMediaBuyerLoop(
  admin: Admin,
  opts: RunMediaBuyerOptions,
): Promise<RunMediaBuyerResult> {
  const nowMs = opts.nowMs ?? Date.now();

  // ── Read policy + cohort FIRST — the trust gate branches on the policy's signal source. ──
  // Phase 3: resolve the cohort for THIS (account, product) tuple. The dispatcher passes
  // `productId` from the enumerated `media_buyer_test_cohorts` row so a shared account's
  // product-A pass reads A's cohort (per-product ceiling + adset), a product-B pass reads
  // B's. A null `productId` falls back to the null-product account default (Superfood Tabs
  // today) — the pre-Phase-2 shape is preserved.
  const [policy, cohort] = await Promise.all([
    loadActivePolicy(opts.workspaceId, opts.metaAdAccountId),
    getEffectiveMediaBuyerTestCohort(admin, opts.workspaceId, {
      metaAdAccountId: opts.metaAdAccountId,
      productId: opts.productId ?? null,
    }),
  ]);

  // ── Trust gate ────────────────────────────────────────────────────────────
  // Before computeMediaBuyerPlan, refuse to act on an untrusted signal.
  //
  // TRUST-META path (CEO 2026-07-10): for Meta-based media buying we trust Meta's OWN reported
  // conversions (meta_insights_daily). Our internal order-match can't resolve Shopify-destined ad
  // revenue, so the internal-resolve coverage gate is the WRONG gate here — instead gate on Meta-signal
  // FRESHNESS (a recent adset scorecard for this account). See [[media-buyer-agent]].
  //
  // Otherwise (internal-attribution path): the original sensor-trust gate — load the newest
  // `media_buyer_sensor_trust` snapshot and enforce present + fresh (≤48h) + band !== 'red'.
  //
  // Either failure writes ONE dormant director_activity row and returns the dormant summary shape
  // ([[docs/brain/libraries/media-buyer-agent]] § Policy contract) — zero iteration_actions, zero
  // ad_publish_jobs, no Meta motion.
  if (policy?.trust_meta_reported_signal) {
    const fresh = await hasFreshMetaSignal(admin, opts.workspaceId, opts.metaAdAccountId, nowMs);
    if (!fresh) {
      const reason = `no fresh Meta signal — newest adset scorecard for this account is older than ${META_SIGNAL_MAX_AGE_DAYS}d (or absent). Run the insights/scorecard ingest.`;
      await recordDirectorActivity(admin, {
        workspaceId: opts.workspaceId,
        directorFunction: GROWTH_DIRECTOR_FUNCTION,
        actionKind: "media_buyer_sensor_trust_denied",
        specSlug: null,
        reason: `Media Buyer pass skipped — ${reason}`,
        metadata: { meta_ad_account_id: opts.metaAdAccountId, trust_source: "meta_reported", reasons: [reason], autonomous: true },
      });
      const dormantPlan = buildSensorTrustDormantPlan(
        { reason, reasons: ["meta_signal_stale"], band: null, snapshot_date: null, coverage_ratio: null },
        opts.cohortTargetCount ?? DEFAULT_TEST_COHORT_TARGET,
      );
      return { plan: dormantPlan, writes: { iterationActionsInserted: 0, directorActivityRows: 1, publishJobsInserted: 0, amplifiedAdCampaignIds: [] } };
    }
  } else {
    const latestTrust = await readLatestSensorTrust(admin, opts.workspaceId, opts.metaAdAccountId);
    const denial = evaluateSensorTrustSnapshot(latestTrust, nowMs);
    if (denial) {
      await recordDirectorActivity(admin, {
        workspaceId: opts.workspaceId,
        directorFunction: GROWTH_DIRECTOR_FUNCTION,
        actionKind: "media_buyer_sensor_trust_denied",
        specSlug: null,
        reason: `Media Buyer pass skipped — ${denial.reason}`,
        metadata: {
          meta_ad_account_id: opts.metaAdAccountId,
          snapshot_date: denial.snapshot_date,
          band: denial.band,
          coverage_ratio: denial.coverage_ratio,
          reasons: denial.reasons,
          autonomous: true,
        },
      });
      const dormantPlan = buildSensorTrustDormantPlan(
        denial,
        opts.cohortTargetCount ?? DEFAULT_TEST_COHORT_TARGET,
      );
      return {
        plan: dormantPlan,
        writes: { iterationActionsInserted: 0, directorActivityRows: 1, publishJobsInserted: 0, amplifiedAdCampaignIds: [] },
      };
    }
  }

  // If no policy → dormant plan, one dormancy audit row, no writes.
  if (!policy) {
    await recordDirectorActivity(admin, {
      workspaceId: opts.workspaceId,
      directorFunction: GROWTH_DIRECTOR_FUNCTION,
      actionKind: "media_buyer_no_active_policy",
      specSlug: null,
      reason: "Media Buyer pass skipped: no active iteration_policies row — activate a conservative policy to open the loop.",
      metadata: { meta_ad_account_id: opts.metaAdAccountId, autonomous: true },
    });
    const emptyPlan = computeMediaBuyerPlan({
      policy: null,
      cohort,
      winners: [],
      losers: [],
      metaAdIdToAdsetId: new Map(),
      budgets: new Map(),
      readyToTest: [],
      currentTestCohortSize: 0,
      cohortTargetCount: opts.cohortTargetCount,
    });
    return { plan: emptyPlan, writes: { iterationActionsInserted: 0, directorActivityRows: 1, publishJobsInserted: 0, amplifiedAdCampaignIds: [] } };
  }

  // Winners: TRUST-META path crowns on Meta-reported CPA (spend/purchases ≤ crown CPA at ≥ crown spend);
  // otherwise the internal-resolve ROAS path. When trust-Meta is on but the CPA knobs are unset, fall
  // back to the ROAS path so a misconfigured policy degrades safely rather than crowning nothing.
  const useMetaCpa = policy.trust_meta_reported_signal && policy.crown_max_cpa_cents != null && policy.crown_min_spend_cents != null;
  const winners = useMetaCpa
    ? await detectMetaCpaWinners(admin, {
        workspaceId: opts.workspaceId,
        metaAdAccountId: opts.metaAdAccountId,
        crownMaxCpaCents: policy.crown_max_cpa_cents as number,
        crownMinSpendCents: policy.crown_min_spend_cents as number,
        crownMinPurchases: policy.crown_min_purchases ?? 8, // anti-noise floor — ~3 purchases is noise
      })
    : await detectWinners(admin, {
        workspaceId: opts.workspaceId,
        minRoas: policy.scale_up_roas_trigger,
        nowMs,
      });

  const snapshotDate = opts.snapshotDate ?? new Date(nowMs).toISOString().slice(0, 10);

  // Losers: TRUST-META path trims early on Meta-reported CPA (spent past the early-trim floor with no
  // purchases or a CPA already worse than crown); otherwise today's adset scorecards below the ROAS floor.
  let losers: MediaBuyerLoser[];
  if (useMetaCpa) {
    losers = await detectMetaCpaLosers(admin, {
      workspaceId: opts.workspaceId,
      metaAdAccountId: opts.metaAdAccountId,
      earlyTrimMinSpendCents: policy.early_trim_min_spend_cents ?? policy.pause_min_spend_cents,
      // Leading-signal thresholds — defaults derived from the Amazing Coffee laggard analysis (winners
      // ≤$65/ATC & ≤$60 CPM; laggards ≥$100/ATC & ≥$110 CPM), tunable per policy.
      trimMaxCostPerAtcCents: policy.trim_max_cost_per_atc_cents ?? 8000, // $80 cost-per-ATC
      trimMaxCpmCents: policy.trim_max_cpm_cents ?? 10000, // $100 CPM
      crownMaxCpaCents: policy.crown_max_cpa_cents ?? 15000, // winner path — never deadline-retire a crown
      holdBandMaxCpaCents: policy.hold_band_max_cpa_cents ?? 22000, // profit floor — HOLD guard + slow-kill line
      crownMinSpendCents: policy.crown_min_spend_cents ?? 45000, // slow-kill / 0-purchase-backstop floor
      crownMinPurchases: policy.crown_min_purchases ?? 8, // crown-qualified adsets are never deadline-retired
      maxTestSpendCents: policy.max_test_spend_cents ?? 120000, // decision deadline — retire if not crowned
    });
  } else {
  const { data: loserRows } = await admin
    .from("iteration_scorecards_daily")
    .select("id, level, object_id, roas, spend_cents, effective_status")
    .eq("workspace_id", opts.workspaceId)
    .eq("meta_ad_account_id", opts.metaAdAccountId)
    .eq("snapshot_date", snapshotDate)
    .eq("level", "adset")
    .eq("effective_status", "ACTIVE")
    .lt("roas", policy.roas_floor)
    .gte("spend_cents", policy.pause_min_spend_cents);

  // Losers cite a source meta_ad_id (the highest-spend child ad of the losing adset)
  // so the audit trail names the actual creative in decline, not just the wrapper adset.
  const loserAdsetIds = ((loserRows || []) as Array<{ object_id: string }>).map((r) => r.object_id);
  const adsetToDominantAdId = new Map<string, string>();
  if (loserAdsetIds.length) {
    const { data: adsForLosers } = await admin
      .from("meta_ads")
      .select("meta_ad_id, meta_adset_id, spend_cents")
      .in("meta_adset_id", loserAdsetIds)
      .order("spend_cents", { ascending: false });
    for (const a of (adsForLosers || []) as Array<{ meta_ad_id: string; meta_adset_id: string }>) {
      if (!adsetToDominantAdId.has(a.meta_adset_id)) adsetToDominantAdId.set(a.meta_adset_id, a.meta_ad_id);
    }
  }
  losers = ((loserRows || []) as Array<{
    id: string;
    level: string;
    object_id: string;
    roas: number | string | null;
    spend_cents: number | string | null;
  }>).map((r) => ({
    sourceMetaAdId: adsetToDominantAdId.get(r.object_id) ?? r.object_id, // fallback: adset id itself
    targetLevel: (r.level === "campaign" ? "campaign" : "adset") as "adset" | "campaign",
    targetObjectId: r.object_id,
    roas: Number(r.roas ?? 0),
    spendCents: Number(r.spend_cents ?? 0),
    triggeringScorecardId: r.id,
  }));
  }

  // Reactivations — recovered-CPA unpause (Meta attribution lags 24–48h, so a leading-signal trim can be
  // rescued by late purchases). Only under trust-Meta with a crown CPA set.
  const reactivations: MetaCpaReactivation[] = useMetaCpa
    ? await detectMetaCpaReactivations(admin, {
        workspaceId: opts.workspaceId,
        metaAdAccountId: opts.metaAdAccountId,
        crownMaxCpaCents: policy.crown_max_cpa_cents as number,
      })
    : [];

  // Winner ad-grain → parent meta_adset_id lookup (for the promote target).
  const winnerAdIds = winners.map((w) => w.metaAdId);
  const metaAdIdToAdsetId = new Map<string, string>();
  if (winnerAdIds.length) {
    const { data: adsForWinners } = await admin
      .from("meta_ads")
      .select("meta_ad_id, meta_adset_id")
      .in("meta_ad_id", winnerAdIds);
    for (const a of (adsForWinners || []) as Array<{ meta_ad_id: string; meta_adset_id: string }>) {
      metaAdIdToAdsetId.set(a.meta_ad_id, a.meta_adset_id);
    }
  }

  // Budgets on the promote target adsets.
  const promoteAdsetIds = Array.from(new Set(Array.from(metaAdIdToAdsetId.values())));
  const budgets = new Map<string, number | null>();
  if (promoteAdsetIds.length) {
    const { data: adsetBudgets } = await admin
      .from("meta_adsets")
      .select("meta_adset_id, daily_budget_cents")
      .in("meta_adset_id", promoteAdsetIds);
    for (const b of (adsetBudgets || []) as Array<{ meta_adset_id: string; daily_budget_cents: number | null }>) {
      budgets.set(b.meta_adset_id, b.daily_budget_cents);
    }
  }

  // Phase 3 — fatigue signal on the winner's parent adsets. Reads the SAME
  // iteration_scorecards_daily.fatigue_score field the decision engine reads,
  // so a winner suppressed from scale-up on fatigue is the SAME winner that
  // triggers fatigue-replenish (coherent signal, one source of truth).
  const fatigueByAdsetId = new Map<string, number>();
  if (promoteAdsetIds.length) {
    const { data: fatigueRows } = await admin
      .from("iteration_scorecards_daily")
      .select("object_id, fatigue_score")
      .eq("workspace_id", opts.workspaceId)
      .eq("meta_ad_account_id", opts.metaAdAccountId)
      .eq("snapshot_date", snapshotDate)
      .eq("level", "adset")
      .in("object_id", promoteAdsetIds);
    for (const f of (fatigueRows || []) as Array<{ object_id: string; fatigue_score: number | string | null }>) {
      const n = Number(f.fatigue_score ?? 0);
      if (Number.isFinite(n)) fatigueByAdsetId.set(f.object_id, n);
    }
  }

  // Ready-to-test bin + current cohort size (count of ACTIVE origin='media-buyer-test' jobs).
  // [[../../../docs/brain/specs/media-buyer-product-scoped-test-rail]] Phase 2 —
  // both reads are PRODUCT-SCOPED via `cohort.productId`:
  //   • `listReadyToTest` filters `ad_campaigns.product_id = cohort.productId` so
  //     product B's ready creative can never be selected for product A's cohort.
  //   • `readCurrentTestCohortSize` counts only the live test ads whose parent
  //     campaign carries this product's id, so a shared Meta ad account gives
  //     each product its own live-test-target-of-4 (not one shared count).
  // A null-product default cohort (Superfood Tabs today) omits both filters, so
  // its pre-Phase-2 shape is preserved.
  const cohortProductId = cohort?.productId ?? null;
  const { readyToTest } = await listReadyToTest(admin, {
    workspaceId: opts.workspaceId,
    productId: cohortProductId,
  });
  const currentTestCohortSize = await readCurrentTestCohortSize(admin, {
    workspaceId: opts.workspaceId,
    productId: cohortProductId,
  });

  // ── Compute the plan ──────────────────────────────────────────────────────
  const plan = computeMediaBuyerPlan({
    policy,
    cohort,
    winners,
    losers,
    metaAdIdToAdsetId,
    budgets,
    fatigueByAdsetId,
    readyToTest,
    currentTestCohortSize,
    cohortTargetCount: opts.cohortTargetCount,
  });

  // ── Shadow branch (media-buyer-shadow-mode Phase 2) ───────────────────────
  // The CEO's non-negotiable "shadow / read-only before armed" guardrail: when the
  // active policy is on `mode='shadow'`, compute the plan but write ZERO
  // iteration_actions + ZERO ad_publish_jobs and NEVER call amplifyWinner. Instead,
  // emit one `<verb>_shadow` director_activity row per plan action (carrying the full
  // plan_action JSON + mode='shadow') plus a `media_buyer_pass_completed` heartbeat
  // whose metadata also carries mode='shadow' so the audit trail proves the shadow
  // pass ran even when the plan is empty. The flip to `armed` is a separate,
  // audited surface — the runtime here NEVER promotes the mode itself.
  if (policy.mode === "shadow") {
    let directorActivityRows = 0;
    for (const row of buildShadowActivityRows(plan)) {
      const rec = await recordDirectorActivity(admin, {
        workspaceId: opts.workspaceId,
        directorFunction: GROWTH_DIRECTOR_FUNCTION,
        actionKind: row.actionKind,
        specSlug: null,
        reason: row.reason,
        metadata: row.metadata,
      });
      if (rec.recorded) directorActivityRows += 1;
    }
    const heartbeat = await recordDirectorActivity(admin, {
      workspaceId: opts.workspaceId,
      directorFunction: GROWTH_DIRECTOR_FUNCTION,
      actionKind: "media_buyer_pass_completed",
      specSlug: null,
      reason: plan.summary,
      metadata: {
        mode: "shadow",
        policy_version_id: plan.policyVersionId,
        promote_count: plan.promote.length,
        kill_count: plan.kill.length,
        replenish_count: plan.replenish.length,
        fatigue_replenish_count: plan.fatigueReplenish.length,
        amplified_ad_campaign_ids: [],
        cohort_configured: plan.cohortConfigured,
        current_test_cohort_size: plan.currentTestCohortSize,
        cohort_target_count: plan.cohortTargetCount,
        autonomous: true,
      },
    });
    if (heartbeat.recorded) directorActivityRows += 1;
    return {
      plan,
      writes: {
        iterationActionsInserted: 0,
        directorActivityRows,
        publishJobsInserted: 0,
        amplifiedAdCampaignIds: [],
      },
    };
  }

  // ── Persist: iteration_actions + director_activity + ad_publish_jobs ──────
  const writes = { iterationActionsInserted: 0, directorActivityRows: 0, publishJobsInserted: 0, amplifiedAdCampaignIds: [] as string[] };
  const nowIso = new Date(nowMs).toISOString();

  // iteration_actions rows for promote (scale_up) + kill (pause). Same shape the
  // decision-engine persistActions writes — the executor picks these up on next pass.
  const iterationRows: Array<Record<string, unknown>> = [];
  for (const a of plan.promote) {
    iterationRows.push({
      workspace_id: opts.workspaceId,
      meta_ad_account_id: opts.metaAdAccountId,
      snapshot_date: snapshotDate,
      level: a.targetLevel,
      object_id: a.targetObjectId,
      action_type: "scale_up",
      rationale: a.rationale,
      policy_version_id: a.policyVersionId,
      before_budget_cents: a.beforeBudgetCents,
      after_budget_cents: a.afterBudgetCents,
      status: "decided",
      updated_at: nowIso,
    });
  }
  for (const a of plan.kill) {
    iterationRows.push({
      workspace_id: opts.workspaceId,
      meta_ad_account_id: opts.metaAdAccountId,
      snapshot_date: snapshotDate,
      level: a.targetLevel,
      object_id: a.targetObjectId,
      action_type: "pause",
      rationale: a.rationale,
      policy_version_id: a.policyVersionId,
      before_status: "ACTIVE",
      after_status: "PAUSED",
      status: "decided",
      updated_at: nowIso,
    });
  }
  for (const a of reactivations) {
    iterationRows.push({
      workspace_id: opts.workspaceId,
      meta_ad_account_id: opts.metaAdAccountId,
      snapshot_date: snapshotDate,
      level: "adset",
      object_id: a.targetObjectId,
      action_type: "unpause",
      rationale: `Reactivate: late attribution recovered CPP $${(a.cppCents / 100).toFixed(0)} ≤ crown on adset ${a.targetObjectId} ($${(a.spendCents / 100).toFixed(0)} spend).`,
      policy_version_id: policy.id,
      before_status: "PAUSED",
      after_status: "ACTIVE",
      status: "decided",
      updated_at: nowIso,
    });
  }
  if (iterationRows.length) {
    const { error } = await admin
      .from("iteration_actions")
      .upsert(iterationRows, {
        onConflict: "workspace_id,meta_ad_account_id,object_id,action_type,snapshot_date",
        ignoreDuplicates: false,
      });
    if (!error) writes.iterationActionsInserted = iterationRows.length;
  }

  // director_activity row per plan action — the "cites concrete ROAS + meta_ad_id" audit trail.
  for (const a of plan.promote) {
    const r = await recordDirectorActivity(admin, {
      workspaceId: opts.workspaceId,
      directorFunction: GROWTH_DIRECTOR_FUNCTION,
      actionKind: "media_buyer_promoted_winner",
      specSlug: null,
      reason: a.rationale,
      metadata: {
        source_meta_ad_id: a.sourceMetaAdId,
        roas: a.roas,
        spend_cents: a.spendCents,
        target_level: a.targetLevel,
        target_object_id: a.targetObjectId,
        before_budget_cents: a.beforeBudgetCents,
        after_budget_cents: a.afterBudgetCents,
        policy_version_id: a.policyVersionId,
        source_ad_campaign_id: a.sourceAdCampaignId,
        autonomous: true,
      },
    });
    if (r.recorded) writes.directorActivityRows += 1;
    // Learning flywheel — a crowned winner marks its combination WON.
    await stampCreativeOutcome(admin, { workspaceId: opts.workspaceId, adCampaignId: a.sourceAdCampaignId, metaAdsetId: a.targetObjectId, outcome: "won", spendCents: a.spendCents }).catch(() => {});
  }
  for (const a of plan.kill) {
    const r = await recordDirectorActivity(admin, {
      workspaceId: opts.workspaceId,
      directorFunction: GROWTH_DIRECTOR_FUNCTION,
      actionKind: "media_buyer_paused_loser",
      specSlug: null,
      reason: a.rationale,
      metadata: {
        source_meta_ad_id: a.sourceMetaAdId,
        roas: a.roas,
        spend_cents: a.spendCents,
        target_level: a.targetLevel,
        target_object_id: a.targetObjectId,
        policy_version_id: a.policyVersionId,
        autonomous: true,
      },
    });
    if (r.recorded) writes.directorActivityRows += 1;
    // Learning flywheel — a trimmed laggard marks its combination LOST (so the concept can be re-tried
    // in a DIFFERENT combination; it only retires after several combinations lose).
    await stampCreativeOutcome(admin, { workspaceId: opts.workspaceId, metaAdsetId: a.targetObjectId, outcome: "lost", spendCents: a.spendCents }).catch(() => {});
  }
  for (const a of reactivations) {
    const r = await recordDirectorActivity(admin, {
      workspaceId: opts.workspaceId,
      directorFunction: GROWTH_DIRECTOR_FUNCTION,
      actionKind: "media_buyer_reactivated_recovered",
      specSlug: null,
      reason: `Reactivate adset ${a.targetObjectId}: late attribution recovered CPP $${(a.cppCents / 100).toFixed(0)} ≤ crown.`,
      metadata: {
        source_meta_ad_id: a.sourceMetaAdId,
        target_object_id: a.targetObjectId,
        spend_cents: a.spendCents,
        cpp_cents: a.cppCents,
        policy_version_id: policy.id,
        autonomous: true,
      },
    });
    if (r.recorded) writes.directorActivityRows += 1;
    // Learning flywheel — a recovered adset marks its combination REACTIVATED (counts as a win).
    await stampCreativeOutcome(admin, { workspaceId: opts.workspaceId, metaAdsetId: a.targetObjectId, outcome: "reactivated", cppCents: a.cppCents, spendCents: a.spendCents }).catch(() => {});
  }
  // Phase 3 — fatigue-triggered variant spawn. For each fatigue_replenish action,
  // call amplifyWinner (respects MAX_VARIANTS_PER_WINNER + MAX_AMPLIFICATIONS_PER_DAY
  // caps internally + writes its OWN `amplified_winner` director_activity row). We
  // also stamp a `media_buyer_fatigue_replenish_triggered` row so the audit trail
  // records that the Media Buyer's fatigue signal (not a manual amplify) fired.
  const winnersByAdId = new Map(winners.map((w) => [w.metaAdId, w]));
  for (const a of plan.fatigueReplenish) {
    const winner = winnersByAdId.get(a.sourceMetaAdId);
    if (!winner) continue; // shouldn't happen — plan-computer builds from winners[]
    const result = await amplifyWinner(admin, {
      workspaceId: opts.workspaceId,
      winner,
      n: a.variantCount,
      directorFunction: GROWTH_DIRECTOR_FUNCTION,
      specSlug: "media-buyer-test-winner-loop",
      nowMs,
    });
    const r = await recordDirectorActivity(admin, {
      workspaceId: opts.workspaceId,
      directorFunction: GROWTH_DIRECTOR_FUNCTION,
      actionKind: "media_buyer_fatigue_replenish_triggered",
      specSlug: null,
      reason: a.rationale,
      metadata: {
        source_meta_ad_id: a.sourceMetaAdId,
        roas: a.roas,
        fatigue_score: a.fatigueScore,
        source_ad_campaign_id: a.sourceAdCampaignId,
        policy_version_id: a.policyVersionId,
        variant_count_requested: a.variantCount,
        variants_spawned: result.variants_spawned,
        new_ad_campaign_ids: result.new_ad_campaign_ids,
        amplify_reason: result.reason ?? null,
        day_count_before: result.day_count_before,
        autonomous: true,
      },
    });
    if (r.recorded) writes.directorActivityRows += 1;
    writes.amplifiedAdCampaignIds.push(...result.new_ad_campaign_ids);
  }

  for (const a of plan.replenish) {
    const jobInsert = await enqueueReplenishPublish(admin, opts.workspaceId, cohort, a);
    if (jobInsert.inserted) {
      writes.publishJobsInserted += 1;
      const r = await recordDirectorActivity(admin, {
        workspaceId: opts.workspaceId,
        directorFunction: GROWTH_DIRECTOR_FUNCTION,
        actionKind: "media_buyer_replenished_test_cohort",
        specSlug: null,
        reason: a.rationale,
        metadata: {
          ad_campaign_id: a.adCampaignId,
          ad_publish_job_id: jobInsert.jobId,
          meta_adset_id: a.testMetaAdsetId,
          daily_test_ceiling_cents: a.dailyTestCeilingCents,
          origin: MEDIA_BUYER_TEST_ORIGIN,
          autonomous: true,
        },
      });
      if (r.recorded) writes.directorActivityRows += 1;
    } else if (jobInsert.reason) {
      const r = await recordDirectorActivity(admin, {
        workspaceId: opts.workspaceId,
        directorFunction: GROWTH_DIRECTOR_FUNCTION,
        actionKind: "media_buyer_replenish_missing_config",
        specSlug: null,
        reason: `Replenish deferred for campaign ${a.adCampaignId}: ${jobInsert.reason}`,
        metadata: {
          ad_campaign_id: a.adCampaignId,
          meta_adset_id: a.testMetaAdsetId,
          missing: jobInsert.reason,
          autonomous: true,
        },
      });
      if (r.recorded) writes.directorActivityRows += 1;
    }
  }

  // Pass heartbeat — one summary row per cadence pass, always emitted.
  const heartbeat = await recordDirectorActivity(admin, {
    workspaceId: opts.workspaceId,
    directorFunction: GROWTH_DIRECTOR_FUNCTION,
    actionKind: "media_buyer_pass_completed",
    specSlug: null,
    reason: plan.summary,
    metadata: {
      policy_version_id: plan.policyVersionId,
      promote_count: plan.promote.length,
      kill_count: plan.kill.length,
      replenish_count: plan.replenish.length,
      fatigue_replenish_count: plan.fatigueReplenish.length,
      amplified_ad_campaign_ids: writes.amplifiedAdCampaignIds,
      cohort_configured: plan.cohortConfigured,
      current_test_cohort_size: plan.currentTestCohortSize,
      cohort_target_count: plan.cohortTargetCount,
      autonomous: true,
    },
  });
  if (heartbeat.recorded) writes.directorActivityRows += 1;

  return { plan, writes };
}

// ── Per-account (account × product) fan-out (Phase 3) ────────────────────────

/**
 * [[../../../docs/brain/specs/media-buyer-product-scoped-test-rail]] Phase 3 —
 * enumerate the ACTIVE `media_buyer_test_cohorts.product_id` values for one
 * (workspace, account). The result is the fan-out list the dispatcher iterates:
 * one entry per active cohort. A null-product cohort surfaces as null (the
 * account default — Superfood Tabs today). An account with NO active cohort
 * returns `[null]` so the dispatcher still emits ONE dormant heartbeat pass
 * (never a silent no-op).
 *
 * Deterministic ordering: product ids are sorted ascending, with the null-product
 * default LAST — so the pass ordering is stable across runs.
 */
export async function readActiveCohortProductIds(
  admin: Admin,
  args: { workspaceId: string; metaAdAccountId: string },
): Promise<Array<string | null>> {
  const { data, error } = await admin
    .from("media_buyer_test_cohorts")
    .select("id, product_id")
    .eq("workspace_id", args.workspaceId)
    .eq("meta_ad_account_id", args.metaAdAccountId)
    .eq("is_active", true);
  if (error) throw new Error(`media_buyer_test_cohorts read failed: ${error.message}`);

  const productIds: (string | null)[] = ((data ?? []) as Array<{ product_id: string | null }>)
    .map((r) => r.product_id ?? null)
    .sort((a, b) => {
      if (a === b) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return a < b ? -1 : 1;
    });
  // Defensive dedupe — the Phase-1 (workspace, account, product_id) partial
  // unique index guarantees uniqueness in prod, but the dispatcher never trusts
  // the DB shape blindly.
  const seen = new Set<string>();
  const unique: (string | null)[] = [];
  for (const pid of productIds) {
    const key = pid ?? "__null__";
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(pid);
  }
  // No active cohort at all → still run one pass so the dormant heartbeat lands.
  if (unique.length === 0) unique.push(null);
  return unique;
}

/**
 * [[../../../docs/brain/specs/media-buyer-product-scoped-test-rail]] Phase 3 —
 * enumerate the active `media_buyer_test_cohorts` rows for one (workspace,
 * account) and run `runMediaBuyerLoop` ONCE per active cohort. In Bianca's
 * shared-account setup (Amazing Coffee + Creamer in one account) this produces
 * TWO passes with distinct `productId`s; in Superfood Tabs's single-product
 * setup the null-product cohort produces ONE pass with `productId=null` (the
 * pre-Phase-2 shape, preserved).
 *
 * When no active cohort exists for the account (a workspace hasn't opted into
 * the autonomous go-live yet), still runs ONE pass with `productId=null` so
 * the runner's sensor-trust / no-active-policy / no-active-cohort dormant
 * audit rows still emit — the dispatch heartbeat proves the lane ran.
 *
 * Per-pass errors are caught and returned in the result array; the caller
 * (box worker media-buyer lane) reports one row per (account, product) tuple
 * so a single product's failure never hides another product's progress.
 */
export async function runMediaBuyerLoopForAccount(
  admin: Admin,
  opts: Omit<RunMediaBuyerOptions, "productId">,
): Promise<RunMediaBuyerAccountPass[]> {
  const productIds = await readActiveCohortProductIds(admin, {
    workspaceId: opts.workspaceId,
    metaAdAccountId: opts.metaAdAccountId,
  });

  const passes: RunMediaBuyerAccountPass[] = [];
  for (const productId of productIds) {
    try {
      const result = await runMediaBuyerLoop(admin, { ...opts, productId });
      passes.push({ productId, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      passes.push({
        productId,
        result: {
          plan: {
            policyActive: false,
            policyVersionId: null,
            cohortConfigured: false,
            cohortTargetCount: opts.cohortTargetCount ?? DEFAULT_TEST_COHORT_TARGET,
            currentTestCohortSize: 0,
            promote: [],
            kill: [],
            replenish: [],
            fatigueReplenish: [],
            summary: `Media Buyer pass threw: ${msg.slice(0, 200)}`,
          },
          writes: {
            iterationActionsInserted: 0,
            directorActivityRows: 0,
            publishJobsInserted: 0,
            amplifiedAdCampaignIds: [],
          },
        },
        error: msg,
      });
    }
  }
  return passes;
}

/**
 * Insert one `ad_publish_jobs` row for a replenish action (origin='media-buyer-test',
 * publish_active=true) + fire the Inngest publish event. The Phase 1 gate in the
 * publisher re-checks the cohort before flipping the ad ACTIVE — a mid-run cohort
 * retire is caught defensively.
 *
 * We read the campaign's ad_campaigns row for its name + landing_url (used as the
 * ad_name + destination); a campaign with no landing_url is skipped (ready-to-test
 * already filters those out, but belt-and-suspenders here too).
 */
/** The angle-copy shape `resolveReplenishAdCopy` needs (a `product_ad_angles` row, or null when the
 *  campaign has no `angle_id`). */
export type ReplenishAngleCopy = { meta_headline?: string | null; meta_primary_text?: string | null } | null;

/**
 * Resolve the ad copy for a replenish publish job from the campaign's angle — PURE (unit-testable).
 *
 * FAIL-CLOSED: a replenish `ad_publish_jobs` row must never carry empty `headlines`/`primary_texts`. An empty
 * copy set makes [[../inngest/ad-tool]] `adToolPublishToMeta` build a Meta creative whose `asset_feed_spec`
 * has empty `titles[]`/`bodies[]`, which Graph rejects with `meta_400 "The link field is required."` (Meta's
 * misleading error for absent ad copy). Before this guard, `enqueueReplenishPublish` hard-coded `headlines:
 * []` / `primary_texts: []`, so EVERY auto-replenish publish failed at Meta. Returns `ok:false` + a reason
 * when the angle yields no usable copy, so the caller skips the job instead of enqueueing an invalid one.
 */
export function resolveReplenishAdCopy(
  angle: ReplenishAngleCopy,
): { ok: boolean; headlines: string[]; primaryTexts: string[]; reason: string | null } {
  const headlines = [(angle?.meta_headline || "").trim()].filter(Boolean);
  const primaryTexts = [(angle?.meta_primary_text || "").trim()].filter(Boolean);
  if (!headlines.length || !primaryTexts.length) {
    return { ok: false, headlines, primaryTexts, reason: "has no meta_headline/meta_primary_text" };
  }
  return { ok: true, headlines, primaryTexts, reason: null };
}

async function enqueueReplenishPublish(
  admin: Admin,
  workspaceId: string,
  cohort: MediaBuyerTestCohort | null,
  action: MediaBuyerReplenishAction,
): Promise<{ inserted: boolean; jobId: string | null; reason?: string }> {
  if (!cohort) return { inserted: false, jobId: null, reason: "no_active_cohort" };
  const accountId = cohort.defaultMetaAccountId;
  const pageId = cohort.defaultMetaPageId;
  if (!accountId || !pageId) {
    return {
      inserted: false,
      jobId: null,
      reason: `cohort missing default publish target(s): ${[
        !accountId && "default_meta_account_id",
        !pageId && "default_meta_page_id",
      ]
        .filter(Boolean)
        .join(", ")}`,
    };
  }
  const { data: campaign } = await admin
    .from("ad_campaigns")
    .select("id, name, landing_url, angle_id")
    .eq("id", action.adCampaignId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const destination = ((campaign as { landing_url?: string | null } | null)?.landing_url || "").trim();
  if (!destination) return { inserted: false, jobId: null, reason: "campaign has no landing_url" };

  // Populate ad copy from the campaign's angle — replenish must NOT queue empty headlines/primary_texts.
  // A publish job with empty asset_feed_spec titles/bodies makes ad-tool.ts build a malformed Meta creative
  // that Graph rejects with meta_400 "The link field is required." (Meta's misleading error for absent ad
  // copy). Source the copy the SAME way the human publish route does — product_ad_angles via
  // ad_campaigns.angle_id (meta-cpa-signal.ts) — and FAIL CLOSED (skip with a reason) when the angle carries
  // no usable copy, instead of enqueueing an invalid job that only surfaces its failure at Meta.
  const angleId = (campaign as { angle_id?: string | null } | null)?.angle_id ?? null;
  let angle: ReplenishAngleCopy = null;
  if (angleId) {
    const { data } = await admin
      .from("product_ad_angles")
      .select("meta_headline, meta_primary_text")
      .eq("id", angleId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    angle = data as ReplenishAngleCopy;
  }
  const copy = resolveReplenishAdCopy(angle);
  if (!copy.ok) {
    return {
      inserted: false,
      jobId: null,
      reason: angleId
        ? `campaign angle ${copy.reason} — skipped to avoid a malformed Meta creative (meta_400 'link field is required')`
        : "campaign has no angle_id — no ad-copy source; skipped to avoid a malformed Meta creative",
    };
  }
  const { headlines, primaryTexts } = copy;

  const { data: video } = await admin
    .from("ad_videos")
    .select("id")
    .eq("campaign_id", action.adCampaignId)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!video?.id) return { inserted: false, jobId: null, reason: "campaign has no ready ad_videos row" };

  const adName = ((campaign as { name?: string | null } | null)?.name || `Media Buyer test — ${action.adCampaignId.slice(0, 8)}`).slice(0, 200);

  // Per-test-adset mode: this job carries a `create_adset_spec` — the publisher mints a dedicated
  // ~$150/day ad set for THIS one creative (in the cohort's testing campaign) so the whole budget tests
  // it, then stamps `meta_adset_id`. `meta_adset_id` starts null (no shared adset). Fail CLOSED if the
  // cohort is a per-test cohort but is missing its campaign or adset template — never mint a malformed set.
  let createAdsetSpec: CreateAdsetSpec | null = null;
  let metaAdsetIdForJob: string | null = action.testMetaAdsetId;
  if (action.adsetPerTest) {
    const tmpl = cohort.adsetTemplate;
    const campaignId = cohort.testMetaCampaignId;
    if (!campaignId || !tmpl) {
      return {
        inserted: false,
        jobId: null,
        reason: `per-test cohort missing ${[!campaignId && "test_meta_campaign_id", !tmpl && "adset_template"].filter(Boolean).join(", ")} — skipped to avoid a malformed ad set`,
      };
    }
    createAdsetSpec = {
      campaign_id: campaignId,
      name: adName,
      daily_budget_cents: cohort.perTestDailyBudgetCents,
      pixel_id: tmpl.pixelId,
      custom_event_type: tmpl.customEventType,
      optimization_goal: tmpl.optimizationGoal,
      billing_event: tmpl.billingEvent,
      bid_strategy: tmpl.bidStrategy,
      targeting: tmpl.targeting,
    };
    metaAdsetIdForJob = null;
  }

  const { data: job, error } = await admin
    .from("ad_publish_jobs")
    .insert({
      workspace_id: workspaceId,
      campaign_id: action.adCampaignId,
      video_id: video.id,
      meta_account_id: accountId,
      meta_adset_id: metaAdsetIdForJob,
      create_adset_spec: createAdsetSpec,
      meta_page_id: pageId,
      meta_instagram_user_id: cohort.defaultMetaInstagramUserId,
      headlines,
      primary_texts: primaryTexts,
      cta_type: "SHOP_NOW",
      destination_url: destination,
      publish_active: true,
      publish_status: "queued",
      origin: MEDIA_BUYER_TEST_ORIGIN,
      ad_name: adName,
    })
    .select("id")
    .single();
  if (error || !job) return { inserted: false, jobId: null, reason: `insert failed: ${error?.message ?? "no row"}` };

  // Fire the publisher. The publisher's belt-and-suspenders gate ([[./publish-gate]])
  // catches any rail (cohort retired mid-run, over-ceiling) and DOWNGRADES to PAUSED
  // + escalates — the Media Buyer never silently spends past the rail.
  await inngest.send({ name: "ad-tool/publish-to-meta", data: { workspace_id: workspaceId, job_id: job.id } });
  return { inserted: true, jobId: job.id as string };
}
