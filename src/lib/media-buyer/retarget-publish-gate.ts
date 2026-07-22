/**
 * Retarget publish gate — the RETARGET-rail sibling of
 * [[./publish-gate]] `evaluateMediaBuyerTestPublish`.
 *
 * The v3 Ad Creative Engine goal M3
 * ([[../../../docs/brain/specs/retarget-campaign-warm-hot-mixed-content]] Phase 2)
 * ships a THIRD Meta campaign — one lean retarget campaign with a single
 * consolidated adset carrying warm+hot MIXED content — on its own supervisable-
 * autonomy rail (owner, kill-switch, heartbeat). Bianca's cold-only replenish
 * ([[./agent]] `runMediaBuyerLoopForAccount`) is untouched; a PARALLEL sibling
 * publishes into the retarget cohort's `retarget_meta_adset_id`.
 *
 * This file is the fail-closed gate at the money step for that sibling:
 *   • the target `meta_adset_id` MUST match `cohort.retargetMetaAdsetId`
 *     (a wrong adset REFUSES `wrong_adset`);
 *   • projected daily spend MUST stay ≤ `cohort.dailyCeilingCents`
 *     (over ceiling REFUSES `over_ceiling`);
 *   • the creative MUST carry a Max copy-QC verdict clearing the 9/10 floor —
 *     delegated to [[./publish-gate]] `evaluateMaxCopyQcAtPublish` VERBATIM so
 *     the retarget rail can never diverge from the shipped bianca-posts-only-at-
 *     9of10 floor;
 *   • a workspace with NO active retarget cohort row is DORMANT — the gate
 *     REFUSES `no_active_cohort` (opt-in table, workspace hasn't provisioned).
 *
 * On refusal the caller downgrades the ad to PAUSED, records one
 * `director_activity` row with `action_kind='media_buyer_retarget_publish_refused'`
 * (owner: growth), and escalates to the CEO's inbox — mirrors the shipped test
 * rail's escalate-don't-execute north star. Non-retarget origins skip this gate
 * entirely.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { escalateDiagnosisToCeo } from "@/lib/agents/platform-director";
import { recordDirectorActivity } from "@/lib/director-activity";
import {
  evaluateMaxCopyQcAtPublish,
  type MaxCopyQcPublishGateResult,
} from "@/lib/media-buyer/publish-gate";
import {
  getEffectiveRetargetCohort,
  type MediaBuyerRetargetCohort,
} from "@/lib/media-buyer/retarget-cohort";

type Admin = ReturnType<typeof createAdminClient>;

/** The publish-job origin sentinel that opts INTO this gate. */
export const MEDIA_BUYER_RETARGET_ORIGIN = "media-buyer-retarget";

/** The Growth director's function slug (mirrors [[./publish-gate]]). */
const GROWTH_DIRECTOR_FUNCTION = "growth";

/** Deep link surfaced with the CEO escalation. */
const MEDIA_BUYER_RETARGET_DEEP_LINK = "/dashboard/marketing/ads";

/** Why a media-buyer-retarget publish was refused live. Carried on the escalation + the audit row. */
export type MediaBuyerRetargetRefusalReason =
  | "no_active_cohort" // no active `media_buyer_retarget_cohorts` row (workspace hasn't provisioned).
  | "wrong_adset" // requested `meta_adset_id` != cohort's `retarget_meta_adset_id`.
  | "over_ceiling" // projected daily spend > cohort's `daily_ceiling_cents`.
  | "missing_max_copy_qc_verdict" // no Max copy-QC verdict on the creative.
  | "hard_gate_fail" // Max copy-QC hard gate failed (fabrication / cold-offer / competitor leak / render).
  | "below_score_floor"; // Max copy-QC persuasion_score < MAX_QC_ELIGIBILITY_FLOOR (9).

export interface MediaBuyerRetargetGateInput {
  workspaceId: string;
  metaAdAccountId: string | null;
  productId?: string | null;
  metaAdsetId: string;
  /** The daily budget in cents the ad set WILL carry after this publish (Meta ABO). */
  projectedDailyCents: number;
  /** The `ad_campaigns.id` the publish is for — needed for the Max copy-QC gate. */
  adCampaignId: string;
}

export interface MediaBuyerRetargetGateAllowResult {
  allowed: true;
  cohort: MediaBuyerRetargetCohort;
  projectedDailyCents: number;
  ceilingCents: number;
  copyQc: MaxCopyQcPublishGateResult;
}

export interface MediaBuyerRetargetGateRefuseResult {
  allowed: false;
  reason: MediaBuyerRetargetRefusalReason;
  cohort: MediaBuyerRetargetCohort | null;
  projectedDailyCents: number;
  ceilingCents: number | null;
  diagnosis: string;
  copyQc: MaxCopyQcPublishGateResult | null;
}

export type MediaBuyerRetargetGateResult =
  | MediaBuyerRetargetGateAllowResult
  | MediaBuyerRetargetGateRefuseResult;

/** Human diagnosis surfaced on the CEO escalation body + the growth audit row's `reason`. */
function refusalDiagnosis(
  reason: MediaBuyerRetargetRefusalReason,
  input: MediaBuyerRetargetGateInput,
  cohort: MediaBuyerRetargetCohort | null,
): string {
  const usdProj = (input.projectedDailyCents / 100).toFixed(2);
  const scope = input.metaAdAccountId ? `account ${input.metaAdAccountId}` : "workspace-wide";
  switch (reason) {
    case "no_active_cohort":
      return (
        `Retarget publish REFUSED live: no active media_buyer_retarget_cohorts row for ${scope}. ` +
        `The retarget rail is dormant until you provision a retarget campaign + adset + daily ceiling. ` +
        `Publishing PAUSED to Meta (adset ${input.metaAdsetId}, projected $${usdProj}/day). Your call.`
      );
    case "wrong_adset": {
      const cohortAdsetId = cohort ? cohort.retargetMetaAdsetId : "(none)";
      return (
        `Retarget publish REFUSED live: requested ad set ${input.metaAdsetId} != configured retarget ad set ` +
        `${cohortAdsetId} for ${scope}. The retarget rail publishes into ONE consolidated adset per cohort. ` +
        `Publishing PAUSED to Meta (projected $${usdProj}/day). Your call.`
      );
    }
    case "over_ceiling": {
      const usdCeil = cohort ? (cohort.dailyCeilingCents / 100).toFixed(2) : "?";
      return (
        `Retarget publish REFUSED live: projected $${usdProj}/day exceeds retarget-cohort ceiling $${usdCeil}/day ` +
        `for ${scope} (adset ${input.metaAdsetId}). Publishing PAUSED to Meta. Either raise the ceiling or lower ` +
        `the projected budget. Your call.`
      );
    }
    case "missing_max_copy_qc_verdict":
      return (
        `Retarget publish REFUSED live: creative ${input.adCampaignId} carries no Max copy-QC verdict — ` +
        `fail-closed rail (no verdict = no spend). Publishing PAUSED to Meta. Re-run Max copy-QC or skip.`
      );
    case "hard_gate_fail":
      return (
        `Retarget publish REFUSED live: creative ${input.adCampaignId} failed a Max copy-QC hard gate ` +
        `(fabrication / cold-offer / competitor leak / render). Publishing PAUSED to Meta. Bianca-posts-only-at-9of10 rail.`
      );
    case "below_score_floor":
      return (
        `Retarget publish REFUSED live: creative ${input.adCampaignId} persuasion_score below the 9/10 floor. ` +
        `Publishing PAUSED to Meta. Bianca-posts-only-at-9of10 rail — the retarget rail honors the same floor.`
      );
  }
}

/**
 * Evaluate a media-buyer-retarget publish request against the workspace's
 * retarget cohort. Returns `{ allowed: true, cohort, ceilingCents, projectedDailyCents, copyQc }`
 * when the publish may go live, or `{ allowed: false, reason, diagnosis, ... }`
 * otherwise. NEVER escalates — the caller runs `escalateMediaBuyerRetargetPublishRefusal`
 * on a refuse verdict so the audit trail records WHO caught the rail (the runner
 * vs the publisher). Non-retarget origins should skip this call.
 *
 * The Max copy-QC gate ([[./publish-gate]] `evaluateMaxCopyQcAtPublish`) is called
 * VERBATIM so the retarget rail can never drift from the shipped bianca-posts-only-
 * at-9of10 floor. A missing verdict / hard-gate fail / below-floor score routes to
 * the corresponding refusal reason (missing_max_copy_qc_verdict / hard_gate_fail /
 * below_score_floor). Precedence: cohort check → adset match → ceiling → copy-QC.
 */
export async function evaluateMediaBuyerRetargetPublish(
  admin: Admin,
  input: MediaBuyerRetargetGateInput,
): Promise<MediaBuyerRetargetGateResult> {
  const cohort = await getEffectiveRetargetCohort(admin, input.workspaceId, {
    metaAdAccountId: input.metaAdAccountId,
    productId: input.productId ?? null,
  });
  if (!cohort) {
    return {
      allowed: false,
      reason: "no_active_cohort",
      cohort: null,
      projectedDailyCents: input.projectedDailyCents,
      ceilingCents: null,
      diagnosis: refusalDiagnosis("no_active_cohort", input, null),
      copyQc: null,
    };
  }
  if (cohort.retargetMetaAdsetId !== input.metaAdsetId) {
    return {
      allowed: false,
      reason: "wrong_adset",
      cohort,
      projectedDailyCents: input.projectedDailyCents,
      ceilingCents: cohort.dailyCeilingCents,
      diagnosis: refusalDiagnosis("wrong_adset", input, cohort),
      copyQc: null,
    };
  }
  if (input.projectedDailyCents > cohort.dailyCeilingCents) {
    return {
      allowed: false,
      reason: "over_ceiling",
      cohort,
      projectedDailyCents: input.projectedDailyCents,
      ceilingCents: cohort.dailyCeilingCents,
      diagnosis: refusalDiagnosis("over_ceiling", input, cohort),
      copyQc: null,
    };
  }
  // Max copy-QC — VERBATIM re-use of the shipped 9/10 floor. A drift here would
  // mean the retarget rail could post below-floor while Bianca's cold rail
  // refuses (or vice versa); the shared chokepoint keeps both honest.
  const copyQc = await evaluateMaxCopyQcAtPublish(admin, {
    workspaceId: input.workspaceId,
    adCampaignId: input.adCampaignId,
  });
  if (!copyQc.ok) {
    const reason: MediaBuyerRetargetRefusalReason =
      copyQc.reason === "missing_max_copy_qc_verdict"
        ? "missing_max_copy_qc_verdict"
        : copyQc.reason === "hard_gate_fail"
          ? "hard_gate_fail"
          : "below_score_floor";
    return {
      allowed: false,
      reason,
      cohort,
      projectedDailyCents: input.projectedDailyCents,
      ceilingCents: cohort.dailyCeilingCents,
      diagnosis: refusalDiagnosis(reason, input, cohort),
      copyQc,
    };
  }
  return {
    allowed: true,
    cohort,
    projectedDailyCents: input.projectedDailyCents,
    ceilingCents: cohort.dailyCeilingCents,
    copyQc,
  };
}

/** Stable dedupe key so one OPEN CEO escalation exists per (workspace, adset, reason). */
function refusalDedupeKey(
  workspaceId: string,
  adsetId: string,
  reason: MediaBuyerRetargetRefusalReason,
): string {
  return `media_buyer_retarget_gate:${workspaceId}:${adsetId}:${reason}`;
}

export interface MediaBuyerRetargetPublishRefusalEscalateArgs {
  workspaceId: string;
  metaAdsetId: string;
  metaAdAccountId: string | null;
  projectedDailyCents: number;
  reason: MediaBuyerRetargetRefusalReason;
  diagnosis: string;
  ceilingCents: number | null;
  /** The publish job id (nullable — the runner may escalate BEFORE inserting the job row). */
  jobId?: string | null;
  /** The campaign id backing this publish (surfaces in the audit metadata). */
  campaignId?: string | null;
  /** The retarget cohort id (audit metadata). */
  cohortId?: string | null;
}

/**
 * Emit the CEO escalation + the growth-owned director_activity audit row for a
 * refused media-buyer-retarget publish. Deduped by `escalateDiagnosisToCeo`'s
 * notification check on `dedupe_key` — one OPEN escalation per (workspace, adset,
 * reason) at a time. Best-effort: a missed audit write never blocks the caller,
 * matching [[./publish-gate]] `escalateMediaBuyerTestPublishRefusal`.
 */
export async function escalateMediaBuyerRetargetPublishRefusal(
  admin: Admin,
  args: MediaBuyerRetargetPublishRefusalEscalateArgs,
): Promise<{ emitted: boolean }> {
  const dedupeKey = refusalDedupeKey(args.workspaceId, args.metaAdsetId, args.reason);
  const title = `Retarget gate refused: ${args.reason.replace(/_/g, " ")}`;
  const metadata = {
    origin: MEDIA_BUYER_RETARGET_ORIGIN,
    reason: args.reason,
    meta_adset_id: args.metaAdsetId,
    meta_ad_account_id: args.metaAdAccountId,
    projected_daily_cents: args.projectedDailyCents,
    ceiling_cents: args.ceilingCents,
    job_id: args.jobId ?? null,
    ad_campaign_id: args.campaignId ?? null,
    cohort_id: args.cohortId ?? null,
  } as const;

  const ceo = await escalateDiagnosisToCeo(admin, {
    workspaceId: args.workspaceId,
    specSlug: null,
    title,
    diagnosis: args.diagnosis,
    dedupeKey,
    deepLink: MEDIA_BUYER_RETARGET_DEEP_LINK,
    escalationKind: "media_buyer_retarget_gate_refused",
    metadata,
  });
  if (!ceo.emitted) return { emitted: false };

  await recordDirectorActivity(admin, {
    workspaceId: args.workspaceId,
    directorFunction: GROWTH_DIRECTOR_FUNCTION,
    actionKind: "media_buyer_retarget_publish_refused",
    specSlug: null,
    reason: args.diagnosis,
    metadata: { ...metadata, dedupe_key: dedupeKey, autonomous: true },
  });
  return { emitted: true };
}
