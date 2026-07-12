/**
 * provision-cohort — stand up a product's per-test-adset testing cohort (the "make the campaign +
 * template" half; the media buyer then creates a $150 adset per test creative and runs it).
 *
 * The researched model (docs/brain/reference/meta-scaling-methodology.md): an ABO testing campaign with
 * ONE creative per dedicated ad set, each at `perTestDailyBudgetCents` (~$150/day) so the whole budget
 * tests that one creative; `dailyTestCeilingCents ÷ perTestDailyBudgetCents` = max concurrent tests
 * (4 at $600/$150). This helper is idempotent: it find-or-creates the account's ABO testing campaign
 * ([[../meta-ads]] getOrCreateTestingCampaign) and upserts a `media_buyer_test_cohorts` row with
 * `adset_per_test=true` + the cloned adset template. It creates NO ad sets and spends NOTHING — the
 * campaign lands PAUSED and per-test ad sets are minted later by the replenish/publish path.
 *
 * See docs/brain/libraries/provision-cohort.md · docs/brain/tables/media_buyer_test_cohorts.md.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { getMetaUserToken, getOrCreateTestingCampaign } from "@/lib/meta-ads";

type Admin = ReturnType<typeof createAdminClient>;

/** The proven cold-test audience (cloned from Amazing Coffee's live MB test adsets): US 18–65, home+recent,
 *  Advantage+ Audience on. Callers override per product/account as needed. */
export const DEFAULT_TEST_TARGETING: Record<string, unknown> = {
  age_min: 18,
  age_max: 65,
  geo_locations: { countries: ["US"], location_types: ["home", "recent"] },
  targeting_automation: { advantage_audience: 1 },
};

export interface AdsetTemplate {
  optimizationGoal: string;
  billingEvent: string;
  bidStrategy: string;
  pixelId: string;
  customEventType: string;
  targeting: Record<string, unknown>;
}

/** Max concurrent $150 test ad sets a cohort funds = ceiling ÷ per-test budget (≥1). PURE / unit-tested. */
export function maxConcurrentTests(cohort: { daily_test_ceiling_cents: number; per_test_daily_budget_cents: number }): number {
  const per = cohort.per_test_daily_budget_cents > 0 ? cohort.per_test_daily_budget_cents : 15000;
  return Math.max(1, Math.floor(cohort.daily_test_ceiling_cents / per));
}

/** Build the adset template that every per-test ad set clones (only the CREATIVE varies across a cohort). */
export function buildAdsetTemplate(opts: { pixelId: string; targeting?: Record<string, unknown> }): AdsetTemplate {
  return {
    optimizationGoal: "OFFSITE_CONVERSIONS",
    billingEvent: "IMPRESSIONS",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    pixelId: opts.pixelId,
    customEventType: "PURCHASE",
    targeting: opts.targeting ?? DEFAULT_TEST_TARGETING,
  };
}

export interface ProvisionCohortOptions {
  workspaceId: string;
  productId: string;
  /** `meta_ad_accounts.id` (our UUID) — the cohort's account FK. */
  metaAdAccountUuid: string;
  /** The Meta act id string (e.g. "2352876514967984") — where the campaign/adsets live + budget is charged. */
  metaAccountActId: string;
  /** The Facebook page the ads run under (default_meta_page_id). */
  pageId: string;
  /** The pixel the purchase optimization attributes against. */
  pixelId: string;
  instagramUserId?: string | null;
  targeting?: Record<string, unknown>;
  dailyTestCeilingCents?: number; // $600 default
  perTestDailyBudgetCents?: number; // $150 default
  notes?: string;
}

export interface ProvisionCohortResult {
  cohortId: string;
  testMetaCampaignId: string;
  maxConcurrent: number;
}

/**
 * Provision (or refresh) a product's per-test-adset cohort. Idempotent on (workspace, account, product):
 * re-running find-or-creates the same testing campaign and upserts the cohort row. Creates NO ad sets and
 * spends nothing.
 */
export async function provisionProductTestCohort(admin: Admin, opts: ProvisionCohortOptions): Promise<ProvisionCohortResult> {
  const token = await getMetaUserToken(opts.workspaceId);
  if (!token) throw new Error("no_meta_token");

  const campaignId = await getOrCreateTestingCampaign(token, opts.metaAccountActId);
  const ceiling = opts.dailyTestCeilingCents ?? 60000;
  const perTest = opts.perTestDailyBudgetCents ?? 15000;
  const template = buildAdsetTemplate({ pixelId: opts.pixelId, targeting: opts.targeting });

  const row = {
    workspace_id: opts.workspaceId,
    meta_ad_account_id: opts.metaAdAccountUuid,
    product_id: opts.productId,
    adset_per_test: true,
    test_meta_campaign_id: campaignId,
    per_test_daily_budget_cents: perTest,
    daily_test_ceiling_cents: ceiling,
    adset_template: template,
    default_meta_account_id: opts.metaAccountActId,
    default_meta_page_id: opts.pageId,
    default_meta_instagram_user_id: opts.instagramUserId ?? null,
    is_active: true,
    notes: opts.notes ?? `per-test-adset cohort — ${(ceiling / 100).toFixed(0)}/day, ${(perTest / 100).toFixed(0)}/test. CEO 2026-07-12.`,
  };

  // One active cohort per (workspace, account, product): retire any prior active row, then insert fresh.
  await admin
    .from("media_buyer_test_cohorts")
    .update({ is_active: false })
    .eq("workspace_id", opts.workspaceId)
    .eq("meta_ad_account_id", opts.metaAdAccountUuid)
    .eq("product_id", opts.productId)
    .eq("is_active", true);

  const { data, error } = await admin.from("media_buyer_test_cohorts").insert(row).select("id").single();
  if (error || !data) throw new Error(`cohort_insert_failed: ${error?.message ?? "no row"}`);

  return {
    cohortId: (data as { id: string }).id,
    testMetaCampaignId: campaignId,
    maxConcurrent: maxConcurrentTests({ daily_test_ceiling_cents: ceiling, per_test_daily_budget_cents: perTest }),
  };
}
