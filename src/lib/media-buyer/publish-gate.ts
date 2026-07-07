/**
 * Media Buyer publish gate — the CONTROLLED autonomous go-live rail
 * (media-buyer-test-winner-loop Phase 1).
 *
 * The current Meta publisher (`adToolPublishToMeta`) creates ads PAUSED by default;
 * an operator flips `publish_active=true` from the studio. Phase 1 opens a NARROW,
 * SUPERVISED autonomous go-live for the Media Buyer agent: a publish job flagged
 * `origin='media-buyer-test'` may set `publish_active=true`, BUT ONLY when:
 *   (a) the chosen `meta_adset_id` matches the workspace's configured test ad set
 *       (`media_buyer_test_cohorts.test_meta_adset_id`), AND
 *   (b) the resulting daily budget on that ad set stays within the cohort's
 *       `daily_test_ceiling_cents`.
 *
 * A wrong ad set OR an over-ceiling projection REFUSES the live flag — the job
 * publishes PAUSED and the gate ESCALATES the refusal to the CEO's approval inbox
 * + writes a growth-owned `director_activity` row (per operational-rules § North
 * star: hit a rail = escalate, not execute; the Media Buyer never silently spends).
 *
 * Non-media-buyer origins (studio, engine, etc.) skip this gate entirely — this
 * file is scoped to the Media Buyer's autonomous lane only.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { escalateDiagnosisToCeo } from "@/lib/agents/platform-director";
import { recordDirectorActivity } from "@/lib/director-activity";

type Admin = ReturnType<typeof createAdminClient>;

/** The publish-job origin sentinel that opts INTO this gate. */
export const MEDIA_BUYER_TEST_ORIGIN = "media-buyer-test";

/** The Growth director's function slug (mirrors ad-spend-governor). */
const GROWTH_DIRECTOR_FUNCTION = "growth";

/** Deep link surfaced with the CEO escalation — the marketing/ads page. */
const MEDIA_BUYER_DEEP_LINK = "/dashboard/marketing/ads";

/** The TS shape of a `media_buyer_test_cohorts` row (snake → camel; bigint → number). */
export interface MediaBuyerTestCohort {
  id: string;
  workspaceId: string;
  metaAdAccountId: string | null;
  testMetaAdsetId: string;
  dailyTestCeilingCents: number;
  isActive: boolean;
  notes: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Phase 2 default publish targets — the Media Buyer runner uses these when
   * inserting replenish `ad_publish_jobs` rows (all NULLABLE; a null skips the
   * replenish + records a `media_buyer_replenish_missing_config` audit row). */
  defaultMetaAccountId: string | null;
  defaultMetaPageId: string | null;
  defaultMetaInstagramUserId: string | null;
}

interface MediaBuyerTestCohortRow {
  id: string;
  workspace_id: string;
  meta_ad_account_id: string | null;
  test_meta_adset_id: string;
  daily_test_ceiling_cents: number | string;
  is_active: boolean;
  notes: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  default_meta_account_id?: string | null;
  default_meta_page_id?: string | null;
  default_meta_instagram_user_id?: string | null;
}

function toCohort(row: MediaBuyerTestCohortRow): MediaBuyerTestCohort {
  const c = row.daily_test_ceiling_cents;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    metaAdAccountId: row.meta_ad_account_id,
    testMetaAdsetId: row.test_meta_adset_id,
    dailyTestCeilingCents: typeof c === "string" ? Number(c) : c,
    isActive: row.is_active,
    notes: row.notes,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    defaultMetaAccountId: row.default_meta_account_id ?? null,
    defaultMetaPageId: row.default_meta_page_id ?? null,
    defaultMetaInstagramUserId: row.default_meta_instagram_user_id ?? null,
  };
}

/**
 * The EFFECTIVE test cohort for one `(workspace, meta_ad_account)` tuple — a
 * per-account row wins over the workspace-wide (`meta_ad_account_id IS NULL`) row.
 * Returns null when no active row exists (the gate then REFUSES a media-buyer-test
 * publish — no configured cohort = no autonomous go-live).
 */
export async function getEffectiveMediaBuyerTestCohort(
  admin: Admin,
  workspaceId: string,
  args: { metaAdAccountId?: string | null },
): Promise<MediaBuyerTestCohort | null> {
  const { metaAdAccountId = null } = args;
  const { data, error } = await admin
    .from("media_buyer_test_cohorts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);
  if (error) throw error;
  const rows = (data || []).map((r) => toCohort(r as MediaBuyerTestCohortRow));
  if (!rows.length) return null;
  if (metaAdAccountId) {
    const exact = rows.find((r) => r.metaAdAccountId === metaAdAccountId);
    if (exact) return exact;
  }
  return rows.find((r) => r.metaAdAccountId === null) ?? null;
}

/** Why a media-buyer-test publish was refused live — carried on the escalation + the audit row. */
export type MediaBuyerTestRefusalReason =
  | "no_active_cohort" // no `media_buyer_test_cohorts` row (opt-in table, workspace hasn't configured one).
  | "wrong_adset" // the requested `meta_adset_id` != the cohort's `test_meta_adset_id`.
  | "over_ceiling"; // projected daily spend on the ad set exceeds `daily_test_ceiling_cents`.

export interface MediaBuyerTestGateInput {
  workspaceId: string;
  metaAdAccountId: string | null;
  metaAdsetId: string;
  /** The daily budget in cents the ad set WILL carry after this publish (Meta ABO). */
  projectedDailyCents: number;
}

export interface MediaBuyerTestGateAllowResult {
  allowed: true;
  cohort: MediaBuyerTestCohort;
  projectedDailyCents: number;
  ceilingCents: number;
}

export interface MediaBuyerTestGateRefuseResult {
  allowed: false;
  reason: MediaBuyerTestRefusalReason;
  cohort: MediaBuyerTestCohort | null;
  projectedDailyCents: number;
  ceilingCents: number | null;
  diagnosis: string;
}

export type MediaBuyerTestGateResult =
  | MediaBuyerTestGateAllowResult
  | MediaBuyerTestGateRefuseResult;

/** Human diagnosis surfaced on the CEO escalation body + the growth audit row's `reason`. */
function refusalDiagnosis(
  reason: MediaBuyerTestRefusalReason,
  input: MediaBuyerTestGateInput,
  cohort: MediaBuyerTestCohort | null,
): string {
  const usdProj = (input.projectedDailyCents / 100).toFixed(2);
  const scope = input.metaAdAccountId ? `account ${input.metaAdAccountId}` : "workspace-wide";
  switch (reason) {
    case "no_active_cohort":
      return (
        `Media Buyer publish REFUSED live: no active media_buyer_test_cohorts row for ${scope}. ` +
        `The Media Buyer's autonomous go-live is dormant until you designate a test ad set + daily ceiling. ` +
        `Publishing PAUSED to Meta (adset ${input.metaAdsetId}, projected $${usdProj}/day). Your call.`
      );
    case "wrong_adset": {
      const cohortId = cohort ? cohort.testMetaAdsetId : "(none)";
      return (
        `Media Buyer publish REFUSED live: requested ad set ${input.metaAdsetId} != configured test ad set ` +
        `${cohortId} for ${scope}. Publishing PAUSED to Meta (projected $${usdProj}/day). ` +
        `Point the Media Buyer at the configured test cohort, or update the cohort row. Your call.`
      );
    }
    case "over_ceiling": {
      const usdCeil = cohort ? (cohort.dailyTestCeilingCents / 100).toFixed(2) : "?";
      return (
        `Media Buyer publish REFUSED live: projected $${usdProj}/day exceeds test-cohort ceiling $${usdCeil}/day ` +
        `for ${scope} (adset ${input.metaAdsetId}). Publishing PAUSED to Meta. Either raise the ceiling or ` +
        `lower the projected budget. Your call.`
      );
    }
  }
}

/**
 * Evaluate a media-buyer-test publish request against the workspace's test cohort.
 * Returns `{ allowed: true, cohort, ceilingCents, projectedDailyCents }` when the
 * publish may go live, or `{ allowed: false, reason, diagnosis, ... }` otherwise.
 * NEVER escalates — the caller runs `escalateMediaBuyerTestPublishRefusal` on a
 * refuse verdict so the audit trail records WHO caught the rail (the route vs the
 * publisher). Non-media-buyer origins should skip this call.
 */
export async function evaluateMediaBuyerTestPublish(
  admin: Admin,
  input: MediaBuyerTestGateInput,
): Promise<MediaBuyerTestGateResult> {
  const cohort = await getEffectiveMediaBuyerTestCohort(admin, input.workspaceId, {
    metaAdAccountId: input.metaAdAccountId,
  });
  if (!cohort) {
    return {
      allowed: false,
      reason: "no_active_cohort",
      cohort: null,
      projectedDailyCents: input.projectedDailyCents,
      ceilingCents: null,
      diagnosis: refusalDiagnosis("no_active_cohort", input, null),
    };
  }
  if (cohort.testMetaAdsetId !== input.metaAdsetId) {
    return {
      allowed: false,
      reason: "wrong_adset",
      cohort,
      projectedDailyCents: input.projectedDailyCents,
      ceilingCents: cohort.dailyTestCeilingCents,
      diagnosis: refusalDiagnosis("wrong_adset", input, cohort),
    };
  }
  if (input.projectedDailyCents > cohort.dailyTestCeilingCents) {
    return {
      allowed: false,
      reason: "over_ceiling",
      cohort,
      projectedDailyCents: input.projectedDailyCents,
      ceilingCents: cohort.dailyTestCeilingCents,
      diagnosis: refusalDiagnosis("over_ceiling", input, cohort),
    };
  }
  return {
    allowed: true,
    cohort,
    projectedDailyCents: input.projectedDailyCents,
    ceilingCents: cohort.dailyTestCeilingCents,
  };
}

/** Stable dedupe key so one OPEN CEO escalation exists per (workspace, adset, refusal reason). */
function refusalDedupeKey(workspaceId: string, adsetId: string, reason: MediaBuyerTestRefusalReason): string {
  return `media_buyer_test_gate:${workspaceId}:${adsetId}:${reason}`;
}

export interface MediaBuyerTestPublishRefusalEscalateArgs {
  workspaceId: string;
  metaAdsetId: string;
  metaAdAccountId: string | null;
  projectedDailyCents: number;
  reason: MediaBuyerTestRefusalReason;
  diagnosis: string;
  ceilingCents: number | null;
  /** The publish job id (nullable — the route may escalate BEFORE inserting the job row). */
  jobId?: string | null;
  /** The campaign id backing this publish (surfaces in the audit metadata). */
  campaignId?: string | null;
}

/**
 * Emit the CEO escalation + the growth-owned director_activity audit row for a
 * refused media-buyer-test publish. Deduped by `escalateDiagnosisToCeo`'s notification
 * check on `dedupe_key` — one OPEN escalation per (workspace, adset, reason) at a time.
 */
export async function escalateMediaBuyerTestPublishRefusal(
  admin: Admin,
  args: MediaBuyerTestPublishRefusalEscalateArgs,
): Promise<{ emitted: boolean }> {
  const dedupeKey = refusalDedupeKey(args.workspaceId, args.metaAdsetId, args.reason);
  const title = `Media Buyer gate refused: ${args.reason.replace(/_/g, " ")}`;
  const metadata = {
    origin: MEDIA_BUYER_TEST_ORIGIN,
    reason: args.reason,
    meta_adset_id: args.metaAdsetId,
    meta_ad_account_id: args.metaAdAccountId,
    projected_daily_cents: args.projectedDailyCents,
    ceiling_cents: args.ceilingCents,
    job_id: args.jobId ?? null,
    campaign_id: args.campaignId ?? null,
  } as const;

  const ceo = await escalateDiagnosisToCeo(admin, {
    workspaceId: args.workspaceId,
    specSlug: null,
    title,
    diagnosis: args.diagnosis,
    dedupeKey,
    deepLink: MEDIA_BUYER_DEEP_LINK,
    escalationKind: "media_buyer_test_gate_refused",
    metadata,
  });
  if (!ceo.emitted) return { emitted: false };

  await recordDirectorActivity(admin, {
    workspaceId: args.workspaceId,
    directorFunction: GROWTH_DIRECTOR_FUNCTION,
    actionKind: "media_buyer_test_gate_refused",
    specSlug: null,
    reason: args.diagnosis,
    metadata: { ...metadata, dedupe_key: dedupeKey, autonomous: true },
  });
  return { emitted: true };
}
