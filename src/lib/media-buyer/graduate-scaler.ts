/**
 * media-buyer/graduate-scaler — Bianca goal M4 payoff
 * ([[../../../docs/brain/specs/graduate-crowned-winners-into-the-cold-scaler-mint-campaign-and-duplicate]]
 * Phase 2). The MISSING EXECUTION that turns a crowned test winner into scaled
 * spend: for a crowned winner in the test rail, when the product's cold-scaler
 * cohort is ACTIVE and the arming gate authorises, DUPLICATE the winning
 * creative into the cohort's scaler CBO / Advantage+ Sales campaign as a NEW
 * ad set — reusing the exact winning creative/asset verbatim (no re-authoring).
 *
 * The four gates before a Meta write can fire (mirrors the north-star
 * supervisable-autonomy rail — every autonomous surface answers to a
 * confirming predicate against current state, not a coarse proxy):
 *
 *   1. Active cohort exists for `(workspace, meta_ad_account, product)` via
 *      [[./cold-scaler-cohort]] `getEffectiveMediaBuyerColdScalerCohort`. No
 *      row → the scaler rail is dormant; skip with `skip_no_cohort`.
 *   2. Cohort's `scaler_meta_campaign_id` is non-null (Phase 1's mint has
 *      run). Null → skip with `skip_no_campaign` (never mint here — the
 *      Phase-1 mint is the sanctioned surface).
 *   3. Arming authorization row is `allowed=true` AND not past
 *      `expires_at` via [[./cold-scaler-arming-gate]] `readLatestColdScalerArmingAuthorization`.
 *      Denied / missing / expired → skip with `skip_not_armed` — the scaler
 *      cannot move budget without the human-vetoable authorization.
 *   4. Idempotency — the winning creative is NOT already published under
 *      the scaler campaign (`GET /{campaignId}/ads?fields=id,creative{id}`
 *      via [[../meta-ads]] `listAdsForCampaignWithCreative`). A hit → skip
 *      with `skip_already_graduated`; the creative graduates ONCE.
 *
 * Only after all four pass does the flow call `createAdSet` + `createAd` on
 * Meta with the winning targeting/pixel/creative reused verbatim. Both Meta
 * writes land PAUSED (the createAdSet/createAd invariant). The CBO campaign
 * itself carries `daily_budget = cohort.dailyScalerCeilingCents` (set by
 * Phase 1's mint), so the new ad set inherits the ceiling as the shared pool
 * it competes for — that is the ceiling-bounded semantic (the graduate flow
 * NEVER writes a per-adset daily budget; touching the cohort's ceiling is
 * OWNED by the Phase-1 provisioner + the arming gate, not this flow).
 *
 * A skip records a `cold_scaler_graduate_skipped` [[../director-activity]]
 * row (Growth-owned) with a typed `skip_reason` so Cleo's supervision feed
 * shows WHY the scaler stayed put. A successful graduate records a
 * `cold_scaler_graduated` audit row with the source ad id, the source
 * creative id, and the new scaler ad set + ad ids so the lineage is
 * traceable end-to-end.
 *
 * The Meta side effects are injected via `GraduateMetaClient` — production
 * wires the real `getMetaUserToken` + `listAdsForCampaignWithCreative` +
 * `createAdSet` + `createAd` (`makeProductionGraduateMetaClient` below); unit
 * tests wire an in-memory stub so every gate + call sequence is pinned
 * without a Meta round trip. Same seam the retargeting-agent uses for its
 * Meta writes.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import {
  createAd,
  createAdSet,
  getMetaUserToken,
  listAdsForCampaignWithCreative,
} from "@/lib/meta-ads";
import { recordDirectorActivity } from "@/lib/director-activity";
import {
  getEffectiveMediaBuyerColdScalerCohort,
  type MediaBuyerColdScalerCohort,
} from "./cold-scaler-cohort";
import {
  readLatestColdScalerArmingAuthorization,
  type ColdScalerAuthorizationRow,
} from "./cold-scaler-arming-gate";

type Admin = ReturnType<typeof createAdminClient>;

/** The Growth director's function slug — mirrors the arming gate. */
const GROWTH_DIRECTOR_FUNCTION = "growth";

/** The spec slug surfaced on every director_activity row this module writes. */
export const GRADUATE_SCALER_SPEC_SLUG =
  "graduate-crowned-winners-into-the-cold-scaler-mint-campaign-and-duplicate";

/** The crowned test winner's Meta lineage — the caller (`agent.ts`'s action
 *  runner) resolves these from the winner it just crowned before invoking this
 *  flow. Kept minimal so the module can be unit-tested without pulling in the
 *  crown-detection surface. */
export interface CrownedWinnerInput {
  /** Bare Meta ad id (`ads.ad_id` on the winner). Used to name the graduated adset/ad + as source audit. */
  metaAdId: string;
  /** Bare Meta ad-set id — parent of the winning ad. Audited as `source_meta_adset_id`. */
  metaAdsetId: string;
  /** Bare Meta creative id linked to the winning ad — REUSED verbatim on the graduated ad. */
  metaCreativeId: string;
  /** The targeting spec of the winning ad set — reused verbatim on the graduated ad set. */
  targeting: Record<string, unknown>;
  /** The pixel id the winning ad set optimizes against — reused verbatim. */
  pixelId: string;
}

/** Terminal outcomes. Every outcome except `graduated` is a NO-OP — no Meta
 *  write fired. `skip_*` shapes tell the caller WHY the scaler stayed put. */
export type GraduateOutcome =
  | "graduated"
  | "skip_no_cohort"
  | "skip_no_campaign"
  | "skip_not_armed"
  | "skip_already_graduated";

export interface GraduateResult {
  outcome: GraduateOutcome;
  reason: string;
  cohortId: string | null;
  scalerCampaignId: string | null;
  scalerAdsetId: string | null;
  scalerAdId: string | null;
}

/** The Meta-touching seam. Production wires the real helpers; tests wire a stub. */
export interface GraduateMetaClient {
  listAdsForCampaign(campaignId: string): Promise<Array<{ adId: string; creativeId: string }>>;
  createAdSet(args: {
    name: string;
    campaignId: string;
    pixelId: string;
    targeting: Record<string, unknown>;
  }): Promise<string>;
  createAd(args: { name: string; adsetId: string; creativeId: string }): Promise<string>;
}

/**
 * Wire the real Meta helpers behind `GraduateMetaClient`. Loads the
 * per-workspace `ads_management` token once and reuses it across the three
 * calls. Throws `no_meta_token` when the workspace has no active Meta
 * connection — the caller SHOULD guard this and skip cleanly rather than
 * propagate the throw as a graduate failure.
 */
export async function makeProductionGraduateMetaClient(args: {
  workspaceId: string;
  metaAccountActId: string;
}): Promise<GraduateMetaClient> {
  const token = await getMetaUserToken(args.workspaceId);
  if (!token) throw new Error("no_meta_token");
  return {
    listAdsForCampaign: (campaignId) => listAdsForCampaignWithCreative(token, campaignId),
    createAdSet: (a) =>
      createAdSet(token, args.metaAccountActId, {
        name: a.name,
        campaignId: a.campaignId,
        pixelId: a.pixelId,
        targeting: a.targeting,
        // NO dailyBudgetCents — CBO campaign carries the ceiling; the ad set
        // shares the campaign budget pool. `createAdSet` defaults status to
        // PAUSED (the invariant), so nothing spends until reviewed.
      }),
    createAd: (a) =>
      createAd(token, args.metaAccountActId, {
        name: a.name,
        adsetId: a.adsetId,
        creativeId: a.creativeId,
        // status omitted → PAUSED default.
      }),
  };
}

export interface GraduateInput {
  workspaceId: string;
  productId?: string | null;
  /** Our internal UUID for the ad account — used to look up the cohort. */
  metaAdAccountId: string;
  /** The Meta act id string (e.g. `2352876514967984`) — where the campaign / ad set / ad live. */
  metaAccountActId: string;
  winner: CrownedWinnerInput;
  /** Injected clock — tests pin the arming-expiry semantics. */
  now?: Date;
  /** Injected Meta client — production callers pass `makeProductionGraduateMetaClient(...)`. */
  metaClient: GraduateMetaClient;
}

/**
 * The four-gate graduate flow. See file header for the invariants. Never
 * throws on a normal skip — a missing cohort / missing campaign / refused
 * arming / prior graduation all resolve to `skip_*` outcomes with a
 * director_activity row for audit. Meta network errors (createAdSet /
 * createAd throws) DO propagate — the caller decides whether to retry.
 */
export async function graduateCrownedWinnerToScaler(
  admin: Admin,
  input: GraduateInput,
): Promise<GraduateResult> {
  const now = input.now ?? new Date();
  const productId = input.productId ?? null;

  // Gate 1 — active cohort exists.
  const cohort = await getEffectiveMediaBuyerColdScalerCohort(admin, input.workspaceId, {
    metaAdAccountId: input.metaAdAccountId,
    productId,
  });
  if (!cohort || !cohort.isActive) {
    const reason = `no active cold-scaler cohort for account ${input.metaAdAccountId}, product ${productId ?? "null"}`;
    await recordDirectorActivity(admin, {
      workspaceId: input.workspaceId,
      directorFunction: GROWTH_DIRECTOR_FUNCTION,
      actionKind: "cold_scaler_graduate_skipped",
      specSlug: GRADUATE_SCALER_SPEC_SLUG,
      reason,
      metadata: {
        skip_reason: "no_cohort",
        source_meta_ad_id: input.winner.metaAdId,
        source_meta_adset_id: input.winner.metaAdsetId,
        source_meta_creative_id: input.winner.metaCreativeId,
        meta_ad_account_id: input.metaAdAccountId,
        product_id: productId,
        autonomous: true,
      },
    });
    return {
      outcome: "skip_no_cohort",
      reason,
      cohortId: null,
      scalerCampaignId: null,
      scalerAdsetId: null,
      scalerAdId: null,
    };
  }

  // Gate 2 — cohort has a minted scaler campaign (Phase 1's rail).
  if (!cohort.scalerMetaCampaignId) {
    const reason = `cohort ${cohort.id} has no scaler_meta_campaign_id — mint the CBO scaler campaign first (mintAndProvisionColdScalerCampaign)`;
    await recordSkip(admin, input, cohort, null, "no_campaign", reason);
    return {
      outcome: "skip_no_campaign",
      reason,
      cohortId: cohort.id,
      scalerCampaignId: null,
      scalerAdsetId: null,
      scalerAdId: null,
    };
  }

  // Gate 3 — arming authorization is allowed AND not expired.
  const authorization = await readLatestColdScalerArmingAuthorization(admin, {
    workspaceId: input.workspaceId,
    metaAdAccountId: input.metaAdAccountId,
    coldScalerCohortId: cohort.id,
  });
  const armingDenial = describeArmingDenial(authorization, now);
  if (armingDenial) {
    const reason = `cold-scaler arming refused: ${armingDenial}`;
    await recordSkip(admin, input, cohort, authorization, "not_armed", reason);
    return {
      outcome: "skip_not_armed",
      reason,
      cohortId: cohort.id,
      scalerCampaignId: cohort.scalerMetaCampaignId,
      scalerAdsetId: null,
      scalerAdId: null,
    };
  }

  // Gate 4 — idempotency. Meta's `/{campaign}/ads` is the source of truth for
  // "is this creative already published under the scaler?". Anything else
  // (a local marker) can drift; the campaign's own ad list cannot.
  const existingAds = await input.metaClient.listAdsForCampaign(cohort.scalerMetaCampaignId);
  const alreadyGraduated = existingAds.find(
    (a) => a.creativeId === input.winner.metaCreativeId,
  );
  if (alreadyGraduated) {
    const reason = `creative ${input.winner.metaCreativeId} already published under scaler campaign ${cohort.scalerMetaCampaignId} as ad ${alreadyGraduated.adId}`;
    await recordSkip(admin, input, cohort, authorization, "already_graduated", reason, {
      existing_scaler_ad_id: alreadyGraduated.adId,
    });
    return {
      outcome: "skip_already_graduated",
      reason,
      cohortId: cohort.id,
      scalerCampaignId: cohort.scalerMetaCampaignId,
      scalerAdsetId: null,
      scalerAdId: alreadyGraduated.adId,
    };
  }

  // All four gates cleared — duplicate the winning creative into the scaler.
  const adsetName = `MB — Cold Scaler graduate ad ${input.winner.metaAdId.slice(-8)} (${cohort.id.slice(0, 8)})`.slice(0, 250);
  const scalerAdsetId = await input.metaClient.createAdSet({
    name: adsetName,
    campaignId: cohort.scalerMetaCampaignId,
    pixelId: input.winner.pixelId,
    targeting: input.winner.targeting,
  });
  const adName = `MB — Cold Scaler graduate ad ${input.winner.metaAdId.slice(-8)}`.slice(0, 250);
  const scalerAdId = await input.metaClient.createAd({
    name: adName,
    adsetId: scalerAdsetId,
    creativeId: input.winner.metaCreativeId,
  });

  await recordDirectorActivity(admin, {
    workspaceId: input.workspaceId,
    directorFunction: GROWTH_DIRECTOR_FUNCTION,
    actionKind: "cold_scaler_graduated",
    specSlug: GRADUATE_SCALER_SPEC_SLUG,
    reason:
      `Graduated crowned winner ad ${input.winner.metaAdId} into cold-scaler campaign ` +
      `${cohort.scalerMetaCampaignId} as new adset ${scalerAdsetId} + ad ${scalerAdId} ` +
      `(cohort ${cohort.id}, daily ceiling $${(cohort.dailyScalerCeilingCents / 100).toFixed(2)}).`,
    metadata: {
      source_meta_ad_id: input.winner.metaAdId,
      source_meta_adset_id: input.winner.metaAdsetId,
      source_meta_creative_id: input.winner.metaCreativeId,
      cohort_id: cohort.id,
      scaler_campaign_id: cohort.scalerMetaCampaignId,
      scaler_adset_id: scalerAdsetId,
      scaler_ad_id: scalerAdId,
      meta_ad_account_id: input.metaAdAccountId,
      product_id: productId,
      daily_scaler_ceiling_cents: cohort.dailyScalerCeilingCents,
      arming_authorization_id: authorization?.id ?? null,
      autonomous: true,
    },
  });

  return {
    outcome: "graduated",
    reason: `duplicated creative ${input.winner.metaCreativeId} into cold-scaler campaign ${cohort.scalerMetaCampaignId}`,
    cohortId: cohort.id,
    scalerCampaignId: cohort.scalerMetaCampaignId,
    scalerAdsetId,
    scalerAdId,
  };
}

/** Return a human-readable denial reason when the authorization is missing,
 *  refused, or past its `expires_at`; return `null` when it clears. Pure
 *  (unit-tested independently). */
export function describeArmingDenial(
  authorization: ColdScalerAuthorizationRow | null,
  now: Date,
): string | null {
  if (!authorization) return "no arming authorization row for this cohort";
  if (!authorization.allowed) return `arming refused (iso week ${authorization.iso_week})`;
  const expiresAt = Date.parse(authorization.expires_at);
  if (!Number.isFinite(expiresAt)) return `arming authorization has an invalid expires_at (${authorization.expires_at})`;
  if (expiresAt <= now.getTime()) {
    return `arming authorization expired at ${authorization.expires_at}`;
  }
  return null;
}

async function recordSkip(
  admin: Admin,
  input: GraduateInput,
  cohort: MediaBuyerColdScalerCohort,
  authorization: ColdScalerAuthorizationRow | null,
  skipReason: "no_campaign" | "not_armed" | "already_graduated",
  reason: string,
  extraMetadata: Record<string, unknown> = {},
): Promise<void> {
  await recordDirectorActivity(admin, {
    workspaceId: input.workspaceId,
    directorFunction: GROWTH_DIRECTOR_FUNCTION,
    actionKind: "cold_scaler_graduate_skipped",
    specSlug: GRADUATE_SCALER_SPEC_SLUG,
    reason,
    metadata: {
      skip_reason: skipReason,
      source_meta_ad_id: input.winner.metaAdId,
      source_meta_adset_id: input.winner.metaAdsetId,
      source_meta_creative_id: input.winner.metaCreativeId,
      meta_ad_account_id: input.metaAdAccountId,
      product_id: input.productId ?? null,
      cohort_id: cohort.id,
      scaler_campaign_id: cohort.scalerMetaCampaignId,
      arming_authorization_id: authorization?.id ?? null,
      arming_allowed: authorization?.allowed ?? null,
      arming_expires_at: authorization?.expires_at ?? null,
      autonomous: true,
      ...extraMetadata,
    },
  });
}
