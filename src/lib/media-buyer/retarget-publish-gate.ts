/**
 * Retarget publish gate — the CONTROLLED autonomous go-live rail for the Media Buyer's THIRD
 * (retarget) campaign (retarget-campaign-warm-hot-mixed-content Phase 2).
 *
 * Sibling of [[./publish-gate]] `evaluateMediaBuyerTestPublish` (the COLD test rail). A publish
 * flagged `origin='media-buyer-retarget'` may go live ONLY when:
 *   (a) an active [[../../../docs/brain/tables/media_buyer_retarget_cohorts]] row resolves for the
 *       (workspace, account, product) tuple, AND
 *   (b) the chosen `meta_adset_id` matches the cohort's SINGLE consolidated `retarget_meta_adset_id`, AND
 *   (c) the resulting daily budget stays within `daily_ceiling_cents`, AND
 *   (d) the creative clears the SHARED 9/10 Max copy-QC floor — reused verbatim from
 *       [[./publish-gate]] `evaluateMaxCopyQcAtPublish` (NOT re-implemented, so the floor can
 *       never diverge between the cold and retarget rails).
 *
 * A breach REFUSES the live flag — the ad publishes PAUSED and the gate writes ONE growth-owned
 * `director_activity` audit row (`action_kind='media_buyer_retarget_publish_refused'`) so a rail
 * hit ESCALATES per the north star (hit a rail = escalate, not execute). The cold-only invariant
 * of Bianca's existing replenish loop is UNTOUCHED — this gate reads only the retarget cohort.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { recordDirectorActivity } from "@/lib/director-activity";
import { getEffectiveRetargetCohort, type RetargetCohort } from "@/lib/media-buyer/retarget-cohort";
import { evaluateMaxCopyQcAtPublish } from "@/lib/media-buyer/publish-gate";

type Admin = ReturnType<typeof createAdminClient>;

/** The publish-job origin sentinel that opts INTO the retarget gate. */
export const MEDIA_BUYER_RETARGET_ORIGIN = "media-buyer-retarget";

/** The Growth director's function slug (mirrors publish-gate). */
const GROWTH_DIRECTOR_FUNCTION = "growth";

/** The audit `action_kind` a refused retarget publish stamps (north-star escalation record). */
export const MEDIA_BUYER_RETARGET_PUBLISH_REFUSED = "media_buyer_retarget_publish_refused";

/** Why a retarget publish was refused live — carried on the audit row. */
export type MediaBuyerRetargetRefusalReason =
  | "no_active_retarget_cohort" // no active media_buyer_retarget_cohorts row for the scope.
  | "wrong_adset" // requested meta_adset_id != the cohort's single consolidated retarget_meta_adset_id.
  | "over_ceiling" // projected daily spend exceeds daily_ceiling_cents.
  | "max_copy_qc_refused"; // the creative failed the shared 9/10 Max copy-QC gate (defence-in-depth).

export interface MediaBuyerRetargetGateInput {
  workspaceId: string;
  metaAdAccountId: string | null;
  productId?: string | null;
  /** The ad's own campaign uuid — the Max copy-QC gate reads its latest verdict. */
  adCampaignId: string;
  /** The consolidated retarget ad set the publish targets. */
  metaAdsetId: string;
  /** The daily budget in cents the ad set WILL carry after this publish. */
  projectedDailyCents: number;
}

export interface MediaBuyerRetargetGateAllowResult {
  allowed: true;
  cohort: RetargetCohort;
  projectedDailyCents: number;
  ceilingCents: number;
}

export interface MediaBuyerRetargetGateRefuseResult {
  allowed: false;
  reason: MediaBuyerRetargetRefusalReason;
  cohort: RetargetCohort | null;
  projectedDailyCents: number;
  ceilingCents: number | null;
  diagnosis: string;
}

export type MediaBuyerRetargetGateResult =
  | MediaBuyerRetargetGateAllowResult
  | MediaBuyerRetargetGateRefuseResult;

/** Human diagnosis surfaced on the growth audit row's `reason`. */
function refusalDiagnosis(
  reason: MediaBuyerRetargetRefusalReason,
  input: MediaBuyerRetargetGateInput,
  cohort: RetargetCohort | null,
  extra?: string,
): string {
  const usdProj = (input.projectedDailyCents / 100).toFixed(2);
  const scope = input.metaAdAccountId ? `account ${input.metaAdAccountId}` : "workspace-wide";
  switch (reason) {
    case "no_active_retarget_cohort":
      return (
        `Media Buyer RETARGET publish REFUSED live: no active media_buyer_retarget_cohorts row for ${scope}. ` +
        `The retarget go-live is dormant until you designate a retarget campaign + consolidated adset + daily ceiling. ` +
        `Publishing PAUSED to Meta (adset ${input.metaAdsetId}, projected $${usdProj}/day). Your call.`
      );
    case "wrong_adset": {
      const cohortAdset = cohort ? cohort.retargetMetaAdsetId : "(none)";
      return (
        `Media Buyer RETARGET publish REFUSED live: requested ad set ${input.metaAdsetId} != the cohort's single ` +
        `consolidated retarget ad set ${cohortAdset} for ${scope}. Publishing PAUSED to Meta (projected $${usdProj}/day). ` +
        `Point the retarget loop at the configured consolidated adset, or update the cohort row. Your call.`
      );
    }
    case "over_ceiling": {
      const usdCeil = cohort ? (cohort.dailyCeilingCents / 100).toFixed(2) : "?";
      return (
        `Media Buyer RETARGET publish REFUSED live: projected $${usdProj}/day exceeds retarget-cohort ceiling ` +
        `$${usdCeil}/day for ${scope} (adset ${input.metaAdsetId}). Publishing PAUSED to Meta. Either raise the ceiling ` +
        `or lower the projected budget. Your call.`
      );
    }
    case "max_copy_qc_refused":
      return (
        `Media Buyer RETARGET publish REFUSED live: creative for campaign ${input.adCampaignId} failed the shared ` +
        `Max copy-QC floor — ${extra ?? "no passing verdict"}. Fail-closed rail (same 9/10 gate the cold rail uses); ` +
        `no dollars flow until Max clears it. Publishing PAUSED to Meta.`
      );
  }
}

/**
 * Evaluate a media-buyer-retarget publish request against the workspace's retarget cohort.
 * Returns `{ allowed: true, cohort, ceilingCents, projectedDailyCents }` when the publish may go
 * live, or `{ allowed: false, reason, diagnosis, ... }` otherwise. Writes the refusal audit row
 * itself (unlike the cold gate's split escalate helper) so every refusal path records the
 * north-star escalation. Non-retarget origins should skip this call.
 */
export async function evaluateMediaBuyerRetargetPublish(
  admin: Admin,
  input: MediaBuyerRetargetGateInput,
): Promise<MediaBuyerRetargetGateResult> {
  const cohort = await getEffectiveRetargetCohort(admin, input.workspaceId, {
    metaAdAccountId: input.metaAdAccountId,
    productId: input.productId ?? null,
  });

  const refuse = async (
    reason: MediaBuyerRetargetRefusalReason,
    cohortForRow: RetargetCohort | null,
    extra?: string,
  ): Promise<MediaBuyerRetargetGateRefuseResult> => {
    const diagnosis = refusalDiagnosis(reason, input, cohortForRow, extra);
    await writeRetargetRefusalAudit(admin, {
      workspaceId: input.workspaceId,
      reason,
      diagnosis,
      metaAdsetId: input.metaAdsetId,
      metaAdAccountId: input.metaAdAccountId,
      adCampaignId: input.adCampaignId,
      projectedDailyCents: input.projectedDailyCents,
      ceilingCents: cohortForRow ? cohortForRow.dailyCeilingCents : null,
      cohortId: cohortForRow?.id ?? null,
    });
    return {
      allowed: false,
      reason,
      cohort: cohortForRow,
      projectedDailyCents: input.projectedDailyCents,
      ceilingCents: cohortForRow ? cohortForRow.dailyCeilingCents : null,
      diagnosis,
    };
  };

  if (!cohort) return refuse("no_active_retarget_cohort", null);

  // (b) single consolidated adset identity.
  if (cohort.retargetMetaAdsetId !== input.metaAdsetId) {
    return refuse("wrong_adset", cohort);
  }
  // (c) daily ceiling on the consolidated adset.
  if (input.projectedDailyCents > cohort.dailyCeilingCents) {
    return refuse("over_ceiling", cohort);
  }
  // (d) shared 9/10 Max copy-QC floor — REUSED from the cold rail, never re-implemented.
  const qc = await evaluateMaxCopyQcAtPublish(admin, {
    workspaceId: input.workspaceId,
    adCampaignId: input.adCampaignId,
  });
  if (!qc.ok) {
    return refuse("max_copy_qc_refused", cohort, qc.diagnosis);
  }

  return {
    allowed: true,
    cohort,
    projectedDailyCents: input.projectedDailyCents,
    ceilingCents: cohort.dailyCeilingCents,
  };
}

/**
 * Write ONE growth-owned `director_activity` row for a refused retarget publish
 * (`action_kind='media_buyer_retarget_publish_refused'`). Mirrors the refusal-audit pattern in
 * [[./publish-gate]] `escalateMediaBuyerTestPublishRefusal` — the audit trail records WHO caught
 * the rail + the concrete numbers, so a rail hit ESCALATES instead of silently spending.
 */
export async function writeRetargetRefusalAudit(
  admin: Admin,
  args: {
    workspaceId: string;
    reason: MediaBuyerRetargetRefusalReason;
    diagnosis: string;
    metaAdsetId: string;
    metaAdAccountId: string | null;
    adCampaignId: string;
    projectedDailyCents: number;
    ceilingCents: number | null;
    cohortId: string | null;
  },
): Promise<void> {
  await recordDirectorActivity(admin, {
    workspaceId: args.workspaceId,
    directorFunction: GROWTH_DIRECTOR_FUNCTION,
    actionKind: MEDIA_BUYER_RETARGET_PUBLISH_REFUSED,
    specSlug: null,
    reason: args.diagnosis,
    metadata: {
      origin: MEDIA_BUYER_RETARGET_ORIGIN,
      escalation_kind: MEDIA_BUYER_RETARGET_PUBLISH_REFUSED,
      reason: args.reason,
      meta_adset_id: args.metaAdsetId,
      meta_ad_account_id: args.metaAdAccountId,
      ad_campaign_id: args.adCampaignId,
      projected_daily_cents: args.projectedDailyCents,
      ceiling_cents: args.ceilingCents,
      cohort_id: args.cohortId,
      autonomous: true,
    },
  });
}
