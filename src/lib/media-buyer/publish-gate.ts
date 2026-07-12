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
  /**
   * [[../../../docs/brain/specs/media-buyer-product-scoped-test-rail]] Phase 1 —
   * NULL = the (workspace, account) default cohort (Superfood Tabs's shape today);
   * non-null = a per-product cohort in a shared account so each product carries
   * its own adset + ceiling. `getEffectiveMediaBuyerTestCohort` resolves the
   * product-specific row first, then falls back to the null-product default.
   */
  productId: string | null;
  /** The single shared test ad set (legacy `adsetPerTest=false`). NULL for per-test cohorts. */
  testMetaAdsetId: string | null;
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
  /**
   * Per-test-adset model (CEO 2026-07-12). `adsetPerTest=true` → the replenish mints a FRESH
   * `perTestDailyBudgetCents` (~$150) ad set per test creative under `testMetaCampaignId`, cloning
   * `adsetTemplate` so only the creative varies. `daily_test_ceiling_cents ÷ per_test` = max concurrent
   * tests (4 at $600/$150). `adsetPerTest=false` (default) preserves the legacy single-shared-adset shape.
   */
  adsetPerTest: boolean;
  testMetaCampaignId: string | null;
  perTestDailyBudgetCents: number;
  adsetTemplate: AdsetTemplateShape | null;
}

/** The cloned adset spec every per-test ad set inherits (mirrors provision-cohort's `AdsetTemplate`). */
export interface AdsetTemplateShape {
  optimizationGoal: string;
  billingEvent: string;
  bidStrategy: string;
  pixelId: string;
  customEventType: string;
  targeting: Record<string, unknown>;
}

/**
 * The publisher-consumed spec for minting ONE per-test $150 ad set. The media-buyer replenish assembles
 * it from the cohort's `adsetTemplate` + `perTestDailyBudgetCents` + `testMetaCampaignId` and writes it to
 * `ad_publish_jobs.create_adset_spec`; `adToolPublishToMeta` reads it, calls `createAdSet`, and stamps the
 * new `meta_adset_id` on the job BEFORE creating the ad.
 */
export interface CreateAdsetSpec {
  campaign_id: string;
  name: string;
  daily_budget_cents: number;
  pixel_id: string;
  custom_event_type: string;
  optimization_goal: string;
  billing_event: string;
  bid_strategy: string;
  targeting: Record<string, unknown>;
}

interface MediaBuyerTestCohortRow {
  id: string;
  workspace_id: string;
  meta_ad_account_id: string | null;
  product_id?: string | null;
  test_meta_adset_id: string | null;
  daily_test_ceiling_cents: number | string;
  is_active: boolean;
  notes: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  default_meta_account_id?: string | null;
  default_meta_page_id?: string | null;
  default_meta_instagram_user_id?: string | null;
  adset_per_test?: boolean | null;
  test_meta_campaign_id?: string | null;
  per_test_daily_budget_cents?: number | string | null;
  adset_template?: AdsetTemplateShape | null;
}

function toCohort(row: MediaBuyerTestCohortRow): MediaBuyerTestCohort {
  const c = row.daily_test_ceiling_cents;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    metaAdAccountId: row.meta_ad_account_id,
    productId: row.product_id ?? null,
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
    adsetPerTest: row.adset_per_test === true,
    testMetaCampaignId: row.test_meta_campaign_id ?? null,
    perTestDailyBudgetCents:
      row.per_test_daily_budget_cents == null
        ? 15000
        : Number(row.per_test_daily_budget_cents),
    adsetTemplate: (row.adset_template as AdsetTemplateShape | null) ?? null,
  };
}

/**
 * The EFFECTIVE test cohort for one `(workspace, meta_ad_account, product)` tuple.
 *
 * Resolution order ([[../../../docs/brain/specs/media-buyer-product-scoped-test-rail]]
 * Phase 1): the product-specific `(account, productId)` row wins, then falls back
 * to the null-product account default, then to the workspace-wide null-account
 * default. Returns null when no active row exists (the gate then REFUSES a
 * media-buyer-test publish — no configured cohort = no autonomous go-live).
 *
 * `productId` is optional: omitting it (or passing null) preserves the
 * pre-product-scoped shape — the null-product account default is returned as
 * before, so callers that never grew a product dimension (Superfood Tabs today)
 * behave identically.
 */
export async function getEffectiveMediaBuyerTestCohort(
  admin: Admin,
  workspaceId: string,
  args: { metaAdAccountId?: string | null; productId?: string | null },
): Promise<MediaBuyerTestCohort | null> {
  const { metaAdAccountId = null, productId = null } = args;
  const { data, error } = await admin
    .from("media_buyer_test_cohorts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);
  if (error) throw error;
  const rows = (data || []).map((r) => toCohort(r as MediaBuyerTestCohortRow));
  if (!rows.length) return null;
  if (metaAdAccountId) {
    if (productId) {
      const productExact = rows.find(
        (r) => r.metaAdAccountId === metaAdAccountId && r.productId === productId,
      );
      if (productExact) return productExact;
    }
    const accountDefault = rows.find(
      (r) => r.metaAdAccountId === metaAdAccountId && r.productId === null,
    );
    if (accountDefault) return accountDefault;
  }
  return (
    rows.find((r) => r.metaAdAccountId === null && r.productId === null) ?? null
  );
}

/** Why a media-buyer-test publish was refused live — carried on the escalation + the audit row. */
export type MediaBuyerTestRefusalReason =
  | "no_active_cohort" // no `media_buyer_test_cohorts` row (opt-in table, workspace hasn't configured one).
  | "wrong_adset" // the requested `meta_adset_id` != the cohort's `test_meta_adset_id` (shared-adset mode).
  | "over_ceiling" // projected daily spend on the ad set exceeds `daily_test_ceiling_cents`.
  | "over_concurrency" // per-test mode: minting this ad set would push live tests × per-test budget over the ceiling.
  | "cohort_misconfigured"; // per-test cohort missing its campaign/template — can't safely mint an ad set.

export interface MediaBuyerTestGateInput {
  workspaceId: string;
  metaAdAccountId: string | null;
  /**
   * [[../../../docs/brain/specs/media-buyer-product-scoped-test-rail]] Phase 2 —
   * the ad's target product. Passed through to `getEffectiveMediaBuyerTestCohort`
   * so the ceiling read is scoped to the per-product cohort (Amazing Coffee vs
   * Creamer in the same account, etc.). Omitting it (or null) falls back to the
   * null-product account default, preserving Superfood Tabs's pre-Phase-2 shape.
   */
  productId?: string | null;
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
    case "over_concurrency": {
      const usdCeil = cohort ? (cohort.dailyTestCeilingCents / 100).toFixed(2) : "?";
      const usdPer = cohort ? (cohort.perTestDailyBudgetCents / 100).toFixed(2) : "?";
      return (
        `Media Buyer publish REFUSED live: minting another $${usdPer}/day test ad set for ${scope} would push ` +
        `concurrent tests over the $${usdCeil}/day ceiling. Publishing PAUSED to Meta. A live test must retire ` +
        `(kill/crown) to free a slot, or raise the ceiling. Your call.`
      );
    }
    case "cohort_misconfigured":
      return (
        `Media Buyer publish REFUSED live: per-test cohort for ${scope} is missing its testing campaign or ` +
        `adset template — can't safely mint a $${usdProj}/day ad set. Publishing PAUSED to Meta. Re-run ` +
        `provisionProductTestCohort. Your call.`
      );
  }
}

/**
 * Count the DISTINCT active per-test ad sets currently live for a cohort's product — the belt-and-suspenders
 * concurrency source the gate uses to enforce the $600/day ceiling as ≤N live $150 ad sets (the deterministic
 * primary control is the replenish deficit in `computeMediaBuyerPlan`; this is the independent recount at
 * publish time). Mirrors `readCurrentTestCohortSize`: live = `origin='media-buyer-test'`, `publish_active`,
 * `publish_status='published'`, per-test (`create_adset_spec` set); product-scoped via `ad_campaigns.product_id`.
 */
async function countActivePerTestTests(
  admin: Admin,
  args: { workspaceId: string; productId: string | null },
): Promise<number> {
  const { data } = await admin
    .from("ad_publish_jobs")
    .select("campaign_id, meta_adset_id")
    .eq("workspace_id", args.workspaceId)
    .eq("origin", MEDIA_BUYER_TEST_ORIGIN)
    .eq("publish_active", true)
    .eq("publish_status", "published")
    .not("create_adset_spec", "is", null);
  const jobs = (data ?? []) as Array<{ campaign_id: string | null; meta_adset_id: string | null }>;
  const withAdset = jobs.filter((j) => !!j.meta_adset_id);
  if (!args.productId) return new Set(withAdset.map((j) => j.meta_adset_id)).size;

  const campaignIds = withAdset.map((j) => j.campaign_id).filter((id): id is string => !!id);
  if (!campaignIds.length) return 0;
  const { data: camps } = await admin
    .from("ad_campaigns")
    .select("id")
    .eq("workspace_id", args.workspaceId)
    .in("id", campaignIds)
    .eq("product_id", args.productId);
  const okCampaigns = new Set((camps ?? []).map((c) => (c as { id: string }).id));
  const productAdsets = new Set(
    withAdset
      .filter((j) => j.campaign_id && okCampaigns.has(j.campaign_id))
      .map((j) => j.meta_adset_id),
  );
  return productAdsets.size;
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
    };
  }
  // ── Per-test-adset cohort ───────────────────────────────────────────────────
  // Each test creative runs in its OWN freshly-minted ~$150 ad set (not the cohort's single
  // `test_meta_adset_id`), so the shared-adset identity check doesn't apply. Enforce instead:
  //   (a) config present — a testing campaign + adset template to clone (else can't safely mint);
  //   (b) per-adset budget ≤ the per-test budget (no single test ad set carries more than $150);
  //   (c) concurrency — (live per-test ad sets + this one) × per-test budget ≤ daily ceiling ($600).
  if (cohort.adsetPerTest) {
    if (!cohort.testMetaCampaignId || !cohort.adsetTemplate) {
      return {
        allowed: false,
        reason: "cohort_misconfigured",
        cohort,
        projectedDailyCents: input.projectedDailyCents,
        ceilingCents: cohort.dailyTestCeilingCents,
        diagnosis: refusalDiagnosis("cohort_misconfigured", input, cohort),
      };
    }
    if (input.projectedDailyCents > cohort.perTestDailyBudgetCents) {
      return {
        allowed: false,
        reason: "over_ceiling",
        cohort,
        projectedDailyCents: input.projectedDailyCents,
        ceilingCents: cohort.dailyTestCeilingCents,
        diagnosis: refusalDiagnosis("over_ceiling", input, cohort),
      };
    }
    const activeTests = await countActivePerTestTests(admin, {
      workspaceId: input.workspaceId,
      productId: cohort.productId,
    });
    if ((activeTests + 1) * cohort.perTestDailyBudgetCents > cohort.dailyTestCeilingCents) {
      return {
        allowed: false,
        reason: "over_concurrency",
        cohort,
        projectedDailyCents: input.projectedDailyCents,
        ceilingCents: cohort.dailyTestCeilingCents,
        diagnosis: refusalDiagnosis("over_concurrency", input, cohort),
      };
    }
    return {
      allowed: true,
      cohort,
      projectedDailyCents: input.projectedDailyCents,
      ceilingCents: cohort.dailyTestCeilingCents,
    };
  }

  // ── Legacy single-shared-adset cohort ────────────────────────────────────────
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
