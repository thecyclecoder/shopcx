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
import { detectWinners, type DetectedWinner } from "@/lib/ads/winning-creative-detect";
import { listReadyToTest, type ReadyToTestRow } from "@/lib/ads/ready-to-test";
import { loadActivePolicy, type IterationPolicy } from "@/lib/meta/decision-engine";
import { getEffectiveMediaBuyerTestCohort, MEDIA_BUYER_TEST_ORIGIN, type MediaBuyerTestCohort } from "@/lib/media-buyer/publish-gate";
import { inngest } from "@/lib/inngest/client";

type Admin = ReturnType<typeof createAdminClient>;

const GROWTH_DIRECTOR_FUNCTION = "growth";

/** Default number of live creatives the Media Buyer keeps in the test cohort at any time. */
export const DEFAULT_TEST_COHORT_TARGET = 3;

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
  /** The [[media_buyer_test_cohorts]] `test_meta_adset_id` we publish INTO. */
  testMetaAdsetId: string;
  /** The cohort ceiling we pin the ad set's daily budget to. */
  dailyTestCeilingCents: number;
  rationale: string;
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
  readyToTest: ReadyToTestRow[];
  /** How many test-cohort live ads currently exist (published via origin='media-buyer-test'). */
  currentTestCohortSize: number;
  cohortTargetCount?: number;
}

/**
 * Compute the Media Buyer plan for one pass. Pure — no DB, no Meta, no Inngest.
 * The runner passes in all reads; this function returns the typed plan.
 *
 * Returns an empty plan when no active policy exists — the loop is dormant until
 * the Growth director / a human authors + activates one.
 */
export function computeMediaBuyerPlan(input: MediaBuyerPlanInputs): MediaBuyerPlan {
  const cohortTargetCount = input.cohortTargetCount ?? DEFAULT_TEST_COHORT_TARGET;
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
      summary:
        "Dormant: no active iteration_policies row — Media Buyer never scales/kills without a supervised policy. Author + activate a conservative policy to activate the loop.",
    };
  }
  const policy = input.policy;

  // ── Promote ────────────────────────────────────────────────────────────────
  const promote: MediaBuyerPromoteAction[] = [];
  for (const w of input.winners) {
    if (w.roas < policy.scale_up_roas_trigger) continue;
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

  // ── Replenish ──────────────────────────────────────────────────────────────
  const replenish: MediaBuyerReplenishAction[] = [];
  if (input.cohort && input.cohort.isActive) {
    const deficit = Math.max(0, cohortTargetCount - input.currentTestCohortSize);
    const picks = input.readyToTest.slice(0, deficit);
    for (const p of picks) {
      replenish.push({
        kind: "replenish",
        adCampaignId: p.ad_campaign_id,
        testMetaAdsetId: input.cohort.testMetaAdsetId,
        dailyTestCeilingCents: input.cohort.dailyTestCeilingCents,
        rationale: `Replenish test cohort (${input.currentTestCohortSize}/${cohortTargetCount} live) — publishing ready-to-test campaign ${p.ad_campaign_id} into adset ${input.cohort.testMetaAdsetId} via origin='${MEDIA_BUYER_TEST_ORIGIN}'.`,
      });
    }
    if (deficit > 0 && replenish.length < deficit) {
      summaryParts.push(`replenish short: ${replenish.length}/${deficit} — ready-to-test bin exhausted`);
    }
  } else {
    summaryParts.push("cohort dormant — no active media_buyer_test_cohorts row; replenish skipped");
  }

  summaryParts.unshift(
    `promote=${promote.length} kill=${kill.length} replenish=${replenish.length} (policy v${policy.version})`,
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
    summary: summaryParts.join(" · "),
  };
}

// ── Runner orchestrator ───────────────────────────────────────────────────────

export interface RunMediaBuyerOptions {
  workspaceId: string;
  metaAdAccountId: string;
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
  };
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

  // ── Read: policy, cohort, winners, losers, ready-to-test bin ───────────────
  const [policy, cohort] = await Promise.all([
    loadActivePolicy(opts.workspaceId, opts.metaAdAccountId),
    getEffectiveMediaBuyerTestCohort(admin, opts.workspaceId, { metaAdAccountId: null }),
  ]);

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
    return { plan: emptyPlan, writes: { iterationActionsInserted: 0, directorActivityRows: 1, publishJobsInserted: 0 } };
  }

  const winners = await detectWinners(admin, {
    workspaceId: opts.workspaceId,
    minRoas: policy.scale_up_roas_trigger,
    nowMs,
  });

  // Losers: today's adset-grain scorecards below the policy's roas_floor with enough spend.
  const snapshotDate = opts.snapshotDate ?? new Date(nowMs).toISOString().slice(0, 10);
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
  const losers: MediaBuyerLoser[] = ((loserRows || []) as Array<{
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

  // Ready-to-test bin + current cohort size (count of ACTIVE origin='media-buyer-test' jobs).
  const { readyToTest } = await listReadyToTest(admin, { workspaceId: opts.workspaceId });
  const { data: liveTestAds } = await admin
    .from("ad_publish_jobs")
    .select("id")
    .eq("workspace_id", opts.workspaceId)
    .eq("origin", MEDIA_BUYER_TEST_ORIGIN)
    .eq("publish_active", true)
    .eq("publish_status", "published");
  const currentTestCohortSize = (liveTestAds ?? []).length;

  // ── Compute the plan ──────────────────────────────────────────────────────
  const plan = computeMediaBuyerPlan({
    policy,
    cohort,
    winners,
    losers,
    metaAdIdToAdsetId,
    budgets,
    readyToTest,
    currentTestCohortSize,
    cohortTargetCount: opts.cohortTargetCount,
  });

  // ── Persist: iteration_actions + director_activity + ad_publish_jobs ──────
  const writes = { iterationActionsInserted: 0, directorActivityRows: 0, publishJobsInserted: 0 };
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
      cohort_configured: plan.cohortConfigured,
      current_test_cohort_size: plan.currentTestCohortSize,
      cohort_target_count: plan.cohortTargetCount,
      autonomous: true,
    },
  });
  if (heartbeat.recorded) writes.directorActivityRows += 1;

  return { plan, writes };
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
    .select("id, name, landing_url")
    .eq("id", action.adCampaignId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const destination = ((campaign as { landing_url?: string | null } | null)?.landing_url || "").trim();
  if (!destination) return { inserted: false, jobId: null, reason: "campaign has no landing_url" };

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

  const { data: job, error } = await admin
    .from("ad_publish_jobs")
    .insert({
      workspace_id: workspaceId,
      campaign_id: action.adCampaignId,
      video_id: video.id,
      meta_account_id: accountId,
      meta_adset_id: action.testMetaAdsetId,
      meta_page_id: pageId,
      meta_instagram_user_id: cohort.defaultMetaInstagramUserId,
      headlines: [],
      primary_texts: [],
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
