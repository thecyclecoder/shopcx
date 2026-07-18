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
import { isCopyQcEligible, MAX_QC_ELIGIBILITY_FLOOR } from "@/lib/ads/creative-agent";
import { readLatestCopyQaVerdict, type StoredCopyQaVerdict } from "@/lib/ads/creative-qa";
import {
  isPostabilityOverrideActive,
  readPostabilityOverride,
  type PostabilityOverride,
} from "@/lib/ads/postability-override";

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
  /**
   * [[../../../docs/brain/specs/bianca-cold-test-recent-purchaser-exclusion]]
   * Phase 1 — the bare Meta customaudience id (NOT our uuid) of the "last-180d
   * purchasers" website custom audience the cohort must exclude on every
   * per-test ad set. NULL = no exclusion stamped yet (legacy pre-Phase-1 row).
   * When non-null, the Phase 3 publish-gate REFUSES a per-test publish whose
   * proposed `targeting.excluded_custom_audiences` does not carry an entry
   * whose `id === excludedPurchaserAudienceId` (`missing_purchaser_exclusion`).
   */
  excludedPurchaserAudienceId: string | null;
  /**
   * [[../../../docs/brain/specs/bianca-full-order-history-customer-list-exclusion-audience]]
   * Phase 1 — the bare Meta customaudience id (NOT our uuid) of the CUSTOMER_LIST
   * (upload-based) audience the cohort must exclude on every per-test ad set. Built
   * from our ENTIRE order history across Shopify + Internal + Amazon — hashed
   * email+phone, no plaintext PII. NULL = no all-customers exclusion stamped yet
   * (legacy pre-Fix-1 row). When non-null, the publish-gate REFUSES a per-test
   * publish whose proposed `targeting.excluded_custom_audiences` does not carry an
   * entry whose `id === excludedAllCustomersAudienceId` (`missing_customer_exclusion`).
   * Both ids are composed into the same exclusion list on every cold-test adset.
   */
  excludedAllCustomersAudienceId: string | null;
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
  excluded_purchaser_audience_id?: string | null;
  excluded_all_customers_audience_id?: string | null;
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
    excludedPurchaserAudienceId: row.excluded_purchaser_audience_id ?? null,
    excludedAllCustomersAudienceId: row.excluded_all_customers_audience_id ?? null,
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
  | "cohort_misconfigured" // per-test cohort missing its campaign/template — can't safely mint an ad set.
  | "missing_purchaser_exclusion" // per-test mode: cohort carries `excluded_purchaser_audience_id` but the proposed adset targeting does NOT list that id under `excluded_custom_audiences` (bianca-cold-test-recent-purchaser-exclusion Phase 3).
  | "missing_customer_exclusion"; // per-test mode: cohort carries `excluded_all_customers_audience_id` but the proposed adset targeting does NOT list that id under `excluded_custom_audiences` (bianca-full-order-history-customer-list-exclusion-audience Fix 1).

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
  /**
   * [[../../../docs/brain/specs/bianca-cold-test-recent-purchaser-exclusion]]
   * Phase 3 — the proposed adset targeting the publish would submit to Meta.
   * The per-test path passes it via `createAdsetSpec.targeting` (the publisher's
   * `create_adset_spec` shape); a legacy/direct path may pass it via `targeting`.
   * The gate inspects `targeting.excluded_custom_audiences` for the cohort's
   * `excludedPurchaserAudienceId` when non-null and refuses
   * `missing_purchaser_exclusion` if absent. Omitting BOTH is treated as an
   * empty targeting spec (the gate can't verify → refuses when the cohort
   * declares an exclusion; the current callers always pass one on the per-test
   * publish path).
   */
  targeting?: Record<string, unknown> | null;
  createAdsetSpec?: CreateAdsetSpec | null;
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
    case "missing_purchaser_exclusion": {
      const audienceId = cohort?.excludedPurchaserAudienceId ?? "(none)";
      return (
        `Media Buyer publish REFUSED live: adset request for ${scope} must exclude custom audience ${audienceId} — ` +
        `the last-180d-purchasers audience the cohort declares. Its id was NOT present in the proposed ` +
        `targeting.excluded_custom_audiences. Publishing PAUSED to Meta (adset ${input.metaAdsetId}, projected $${usdProj}/day). ` +
        `Re-provision the cohort or fix the template so every per-test ad set inherits the exclusion. Your call.`
      );
    }
    case "missing_customer_exclusion": {
      const audienceId = cohort?.excludedAllCustomersAudienceId ?? "(none)";
      return (
        `Media Buyer publish REFUSED live: adset request for ${scope} must exclude custom audience ${audienceId} — ` +
        `the all-customers (all-order-history, hashed) audience the cohort declares. Its id was NOT present in the ` +
        `proposed targeting.excluded_custom_audiences. Publishing PAUSED to Meta (adset ${input.metaAdsetId}, projected $${usdProj}/day). ` +
        `Re-provision the cohort or fix the template so every per-test ad set inherits the exclusion. Your call.`
      );
    }
  }
}

/**
 * PURE — does the proposed adset targeting spec list `audienceId` under
 * `excluded_custom_audiences`? Reads the shape Meta accepts:
 * `{ excluded_custom_audiences: [{ id: "…" }, …] }`. Anything else (a missing
 * key, a null value, a non-array, an array of non-`{id}` entries) returns
 * false — the exclusion is treated as absent, which is the correct default
 * (no proof = refuse, per the Phase 3 rail).
 */
export function targetingExcludesAudience(
  targeting: Record<string, unknown> | null | undefined,
  audienceId: string,
): boolean {
  if (!targeting) return false;
  const raw = (targeting as Record<string, unknown>).excluded_custom_audiences;
  if (!Array.isArray(raw)) return false;
  for (const entry of raw) {
    if (entry && typeof entry === "object" && (entry as Record<string, unknown>).id === audienceId) return true;
  }
  return false;
}

/**
 * Count the DISTINCT active per-test ad sets currently live for a cohort's product — the belt-and-suspenders
 * concurrency source the gate uses to enforce the $600/day ceiling as ≤N live $150 ad sets (the deterministic
 * primary control is the replenish deficit in `computeMediaBuyerPlan`; this is the independent recount at
 * publish time). Mirrors `readCurrentTestCohortSize`: live = `origin='media-buyer-test'`, `publish_active`,
 * `publish_status='published'`, per-test (`create_adset_spec` set); product-scoped via `ad_campaigns.product_id`.
 */
/** Adset `effective_status` values that DON'T occupy a concurrency slot (paused / not delivering).
 *  Anything else — ACTIVE, PENDING_REVIEW, PREAPPROVED, PENDING_BILLING_INFO, IN_PROCESS — will (or is
 *  about to) spend, so it counts toward the ≤ maxConcurrent cap. Conservative on purpose: an unknown
 *  status counts as occupying, so the rail never UNDER-counts and over-launches. */
export const FREED_ADSET_STATUSES: ReadonlySet<string> = new Set([
  "PAUSED",
  "ADSET_PAUSED",
  "CAMPAIGN_PAUSED",
  "ARCHIVED",
  "DELETED",
]);

/**
 * Count the live test ad sets occupying concurrency slots in a per-test cohort's testing campaign —
 * ORIGIN-AGNOSTIC. Each per-test cohort's `test_meta_campaign_id` is product-specific, so counting the
 * live `meta_adsets` in that campaign == counting that product's concurrent tests. Unlike the old
 * `ad_publish_jobs`-scoped count, this SEES ad sets minted by the legacy media-buyer loop too — the
 * 2026-07-12 Amazing Coffee over-launch was an `ad_publish_jobs`-only count blind to 4 pre-existing
 * adsets, so it replenished 4 ON TOP → 8 live (double the $600 ceiling). Counting live campaign ad sets
 * makes "> maxConcurrent" structurally impossible regardless of who minted the ad set. Returns 0 when no
 * campaign id is given (nothing minted yet). Shared by the plan ([[./agent]] `readCurrentTestCohortSize`)
 * and this gate so both agree on the concurrency count.
 */
export async function countLiveTestAdsetsInCampaign(
  admin: Admin,
  args: { workspaceId: string; testMetaCampaignId: string | null },
): Promise<number> {
  if (!args.testMetaCampaignId) return 0;
  const { data } = await admin
    .from("meta_adsets")
    .select("meta_adset_id, effective_status")
    .eq("workspace_id", args.workspaceId)
    .eq("meta_campaign_id", args.testMetaCampaignId);
  const occupying = new Set<string>();
  for (const r of (data ?? []) as Array<{ meta_adset_id: string; effective_status: string | null }>) {
    if (!FREED_ADSET_STATUSES.has(String(r.effective_status ?? "").toUpperCase())) occupying.add(r.meta_adset_id);
  }
  return occupying.size;
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
    const activeTests = await countLiveTestAdsetsInCampaign(admin, {
      workspaceId: input.workspaceId,
      testMetaCampaignId: cohort.testMetaCampaignId,
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
    // Purchaser-exclusion rail (bianca-cold-test-recent-purchaser-exclusion Phase 3).
    // When the cohort declares an exclusion audience, the per-test publish MUST list its
    // id under the proposed adset targeting's `excluded_custom_audiences`. Prefer the
    // per-test spec's `createAdsetSpec.targeting` (what the publisher will actually POST
    // to Meta); fall back to a bare `input.targeting` if the caller passed one directly.
    // A cohort with a null id has no exclusion declared yet — the check is skipped
    // (legacy pre-Phase-1 rows + the transition window until the backfill runs).
    if (cohort.excludedPurchaserAudienceId) {
      const proposed =
        input.createAdsetSpec?.targeting ?? input.targeting ?? null;
      if (!targetingExcludesAudience(proposed, cohort.excludedPurchaserAudienceId)) {
        return {
          allowed: false,
          reason: "missing_purchaser_exclusion",
          cohort,
          projectedDailyCents: input.projectedDailyCents,
          ceilingCents: cohort.dailyTestCeilingCents,
          diagnosis: refusalDiagnosis("missing_purchaser_exclusion", input, cohort),
        };
      }
    }
    // Customer-list exclusion rail (bianca-full-order-history-customer-list-exclusion-audience Fix 1).
    // Sibling of the purchaser-exclusion rail — same shape, second audience id. When the cohort
    // declares a CUSTOMER_LIST all-customers exclusion, the per-test publish MUST list its id
    // under the proposed adset targeting's `excluded_custom_audiences` alongside the purchaser id.
    if (cohort.excludedAllCustomersAudienceId) {
      const proposed =
        input.createAdsetSpec?.targeting ?? input.targeting ?? null;
      if (!targetingExcludesAudience(proposed, cohort.excludedAllCustomersAudienceId)) {
        return {
          allowed: false,
          reason: "missing_customer_exclusion",
          cohort,
          projectedDailyCents: input.projectedDailyCents,
          ceilingCents: cohort.dailyTestCeilingCents,
          diagnosis: refusalDiagnosis("missing_customer_exclusion", input, cohort),
        };
      }
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

// ── Max copy-QC hard gate at Bianca's publish step ──────────────────────────
// bianca-never-posts-a-creative-without-a-max-grade-of-7-or-higher Phase 1 (with
// bianca-posts-only-at-9of10-plus-ceo-manual-score-override-oversight-gate Phase 1
// raising the floor from 7 to 9) — defence-in-depth over the ad_campaigns eligibility
// flag: at the actual money step (the `ad_publish_jobs` insert + Meta post fan-out),
// independently re-verify the creative carries a valid Max copy-QC verdict with
// `hard_gate_pass` AND `persuasion_score >= MAX_QC_ELIGIBILITY_FLOOR` (9). A
// null/missing verdict or a below-floor score REFUSES the post — the creative is
// skipped, an audit row is written, and no dollars flow. Mirrors the shape of the
// media-buyer test-cohort gate: a dispatched fail-closed rail evaluated at the same
// last-mile chokepoint.
//
// Shares the `MAX_QC_ELIGIBILITY_FLOOR` constant + `isCopyQcEligible` predicate
// with Dahlia's bin gate so the floor can never diverge between the two rails.

/** Why Bianca's publish path refused to post a creative to Meta. */
export type MaxCopyQcPublishRefusalReason =
  | "missing_max_copy_qc_verdict" // no ad_creative_copy_qc_verdicts row (Max never scored the creative).
  | "hard_gate_fail" // verdict exists but a Max hard gate failed (fabrication, cold-offer, competitor leak, single-promise, render).
  | "below_score_floor"; // hard gates passed but persuasion_score < MAX_QC_ELIGIBILITY_FLOOR (9).

export interface MaxCopyQcPublishGateAllowResult {
  ok: true;
  verdict: StoredCopyQaVerdict | null;
  scoreFloor: typeof MAX_QC_ELIGIBILITY_FLOOR;
  /** bianca-posts-only-at-9of10 Phase 2 — the CEO override that authorized this
   *  post, when Max's own verdict would have refused. `null` when Max cleared the
   *  gate on his own (no override needed). Preserved on the allow-result so the
   *  audit row + diagnostics cite whether the CEO or Max let it through. */
  override: PostabilityOverride | null;
}

export interface MaxCopyQcPublishGateRefuseResult {
  ok: false;
  verdict: StoredCopyQaVerdict | null;
  reason: MaxCopyQcPublishRefusalReason;
  scoreFloor: typeof MAX_QC_ELIGIBILITY_FLOOR;
  diagnosis: string;
  override: PostabilityOverride | null;
}

export type MaxCopyQcPublishGateResult =
  | MaxCopyQcPublishGateAllowResult
  | MaxCopyQcPublishGateRefuseResult;

/**
 * PURE — classify a stored Max copy-QC verdict at publish time. Kept exported +
 * pure so a fixture verdict provably routes to the right refusal reason
 * independent of the DB read; the DB-aware `evaluateMaxCopyQcAtPublish` wraps it.
 *
 * Refusal precedence: missing verdict → hard-gate fail → below the score floor.
 * `hard_gate_fail` fires FIRST when `hard_gate_pass === false` regardless of the
 * (advisory / null-forced) `persuasion_score`; below-floor only fires when hard
 * gates passed but the score didn't clear the CEO's 9/10 rule. Mirrors
 * `isCopyQcEligible`'s ordering exactly so the two predicates can never disagree.
 */
export function classifyMaxCopyQcAtPublish(
  verdict: StoredCopyQaVerdict | null,
  scoreFloor: number = MAX_QC_ELIGIBILITY_FLOOR,
):
  | { ok: true }
  | { ok: false; reason: MaxCopyQcPublishRefusalReason } {
  if (!verdict) return { ok: false, reason: "missing_max_copy_qc_verdict" };
  if (!verdict.hard_gate_pass) return { ok: false, reason: "hard_gate_fail" };
  if ((verdict.persuasion_score ?? 0) < scoreFloor) {
    return { ok: false, reason: "below_score_floor" };
  }
  return { ok: true };
}

/**
 * PURE — the composite postability predicate the money step honors from
 * bianca-posts-only-at-9of10 Phase 2 onward. `isPostable = (Max hard_gate_pass
 * AND persuasion_score >= MAX_QC_ELIGIBILITY_FLOOR) OR CEO override present`.
 *
 * Kept as a pure exported helper (parallel to `classifyMaxCopyQcAtPublish`) so
 * a fixture (verdict, override) tuple can be pinned to expected postable state
 * independent of any DB read. The DB-aware `evaluateMaxCopyQcAtPublish` wraps
 * this. Max's real grade on the passed-in verdict is NEVER mutated — a truthy
 * override just adds a second, orthogonal "yes" that shortcuts a would-be
 * refusal.
 */
export function isPostable(
  verdict: StoredCopyQaVerdict | null,
  override: PostabilityOverride | null,
  scoreFloor: number = MAX_QC_ELIGIBILITY_FLOOR,
): boolean {
  if (isPostabilityOverrideActive(override)) return true;
  return classifyMaxCopyQcAtPublish(verdict, scoreFloor).ok;
}

/** Human diagnosis surfaced on the growth audit row's `reason`. */
function maxCopyQcRefusalDiagnosis(
  reason: MaxCopyQcPublishRefusalReason,
  args: { adCampaignId: string; verdict: StoredCopyQaVerdict | null; scoreFloor: number },
): string {
  const { adCampaignId, verdict, scoreFloor } = args;
  switch (reason) {
    case "missing_max_copy_qc_verdict":
      return (
        `Bianca REFUSED to post campaign ${adCampaignId}: no Max copy-QC verdict on record ` +
        `(ad_creative_copy_qc_verdicts empty). Fail-closed rail — no verdict = no spend. ` +
        `Re-run Max copy-QC or skip this creative.`
      );
    case "hard_gate_fail": {
      const failed: string[] = [];
      const g = verdict?.hard_gates;
      if (g) {
        if (!g.no_fabrication) failed.push("no_fabrication");
        if (!g.no_cold_offer) failed.push("no_cold_offer");
        if (!g.no_competitor_leak) failed.push("no_competitor_leak");
        if (!g.single_promise) failed.push("single_promise");
        if (!g.render_ok) failed.push("render_ok");
      }
      return (
        `Bianca REFUSED to post campaign ${adCampaignId}: Max copy-QC hard gate(s) failed ` +
        `[${failed.length ? failed.join(", ") : "unknown"}]. Fail-closed rail — Bianca never posts a ` +
        `creative Max hard-rejected, regardless of the bin eligibility flag.`
      );
    }
    case "below_score_floor": {
      const score = verdict?.persuasion_score ?? null;
      return (
        `Bianca REFUSED to post campaign ${adCampaignId}: Max copy-QC persuasion_score ` +
        `${score === null ? "null" : score} < floor ${scoreFloor}/10. Fail-closed rail — sub-${scoreFloor} ` +
        `creatives never reach Meta, regardless of the bin eligibility flag.`
      );
    }
  }
}

/**
 * DB-aware wrapper — reads the latest Max copy-QC verdict for a creative via the
 * `readLatestCopyQaVerdict` SDK chokepoint, then delegates to `classifyMaxCopyQcAtPublish`.
 * Bianca's replenish path calls this BEFORE inserting an `ad_publish_jobs` row so a
 * below-floor / ungraded creative is skipped at the money step — never enqueued, never posted.
 *
 * INDEPENDENT of the `ad_campaigns` bin-eligibility flag: a mis-flipped flag or a
 * missing / NULL verdict routes to refusal here too. This is the "second, fail-closed
 * check at the money step" the spec's north star calls for — defence-in-depth over
 * the always-bin eligibility state.
 */
export async function evaluateMaxCopyQcAtPublish(
  admin: Admin,
  args: { workspaceId: string; adCampaignId: string; scoreFloor?: number },
): Promise<MaxCopyQcPublishGateResult> {
  const scoreFloor = args.scoreFloor ?? MAX_QC_ELIGIBILITY_FLOOR;
  // Read Max's real grade + the CEO override in parallel — they live in
  // different tables (ad_creative_copy_qc_verdicts vs. ad_campaigns) and are
  // independent: the override never mutates the QC verdict row, which is the
  // whole point of preserving the Max-vs-CEO gap as the tuning signal.
  const [verdict, override] = await Promise.all([
    readLatestCopyQaVerdict(admin, {
      workspaceId: args.workspaceId,
      adCampaignId: args.adCampaignId,
    }),
    readPostabilityOverride(admin, {
      workspaceId: args.workspaceId,
      adCampaignId: args.adCampaignId,
    }),
  ]);
  // bianca-posts-only-at-9of10 Phase 2 — CEO override shortcuts a would-be
  // refusal. An active override (`override_postable=true`) says "post regardless
  // of Max"; Max's real verdict rides on the allow-result unchanged so the
  // audit trail still shows what Max said.
  if (isPostabilityOverrideActive(override)) {
    return { ok: true, verdict, scoreFloor: MAX_QC_ELIGIBILITY_FLOOR, override };
  }
  const classified = classifyMaxCopyQcAtPublish(verdict, scoreFloor);
  if (classified.ok) {
    // A verdict that classifies OK must also satisfy the shared isCopyQcEligible
    // predicate — kept as an assertion so a future drift between the two paths
    // still fails-closed here (defence-in-depth over the bin flag, per the spec).
    if (!isCopyQcEligible(verdict)) {
      return {
        ok: false,
        verdict,
        reason: "below_score_floor",
        scoreFloor: MAX_QC_ELIGIBILITY_FLOOR,
        diagnosis: maxCopyQcRefusalDiagnosis("below_score_floor", { adCampaignId: args.adCampaignId, verdict, scoreFloor }),
        override,
      };
    }
    return { ok: true, verdict: verdict as StoredCopyQaVerdict, scoreFloor: MAX_QC_ELIGIBILITY_FLOOR, override };
  }
  return {
    ok: false,
    verdict,
    reason: classified.reason,
    scoreFloor: MAX_QC_ELIGIBILITY_FLOOR,
    diagnosis: maxCopyQcRefusalDiagnosis(classified.reason, { adCampaignId: args.adCampaignId, verdict, scoreFloor }),
    override,
  };
}
