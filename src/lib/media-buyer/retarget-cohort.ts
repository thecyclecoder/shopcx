/**
 * Media Buyer RETARGET cohort — the RETARGET-rail sibling of the test-cohort
 * ([[../../../docs/brain/libraries/media-buyer-publish-gate]]
 * `getEffectiveMediaBuyerTestCohort`) and cold-scaler-cohort
 * ([[./cold-scaler-cohort]] `getEffectiveMediaBuyerColdScalerCohort`) SDKs.
 * Reads [[../../../docs/brain/tables/media_buyer_retarget_cohorts]] with typed
 * row → object mapping, precedence resolution, enumeration, and a service-role
 * provisioning helper.
 *
 * Introduced by v3 Ad Creative Engine goal M3
 * ([[../../../docs/brain/specs/retarget-campaign-warm-hot-mixed-content]]).
 * The retarget rail publishes warm+hot MIXED content into ONE consolidated
 * Meta adset per cohort; the shipped cold rail
 * ([[./agent]] `runMediaBuyerLoopForAccount`,
 * [[../../../docs/brain/specs/bianca-route-ready-creatives-by-dahlia-temperature-tag]])
 * remains temperature-scoped to `'cold'` and is UNTOUCHED by this SDK.
 *
 * The SDK is the only allowed entry point for reading + writing the cohort —
 * the CLAUDE.md "Raw .from(...) STOP" rule forbids a hand-rolled select
 * against the table (a wrong column name silently reads as empty).
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { resolvePublishIdentity } from "./publish-identity";

type Admin = ReturnType<typeof createAdminClient>;

/** Audience temperatures the retarget rail can publish. */
export type RetargetAudienceTemperature = "warm" | "hot";

/** Default whitelist for a retarget cohort — warm+hot per the v3 goal. */
export const DEFAULT_RETARGET_AUDIENCE_TEMPERATURES: RetargetAudienceTemperature[] = ["warm", "hot"];

/** The TS shape of a `media_buyer_retarget_cohorts` row (snake → camel; bigint → number). */
export interface MediaBuyerRetargetCohort {
  id: string;
  workspaceId: string;
  metaAdAccountId: string | null;
  productId: string | null;
  retargetMetaCampaignId: string;
  retargetMetaAdsetId: string;
  dailyCeilingCents: number;
  audienceTemperatures: RetargetAudienceTemperature[];
  defaultMetaPageId: string | null;
  defaultMetaInstagramUserId: string | null;
  isActive: boolean;
  notes: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MediaBuyerRetargetCohortRow {
  id: string;
  workspace_id: string;
  meta_ad_account_id: string | null;
  product_id: string | null;
  retarget_meta_campaign_id: string;
  retarget_meta_adset_id: string;
  daily_ceiling_cents: number | string;
  audience_temperatures: string[] | null;
  default_meta_page_id: string | null;
  default_meta_instagram_user_id: string | null;
  is_active: boolean;
  notes: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

function toRetargetCohort(row: MediaBuyerRetargetCohortRow): MediaBuyerRetargetCohort {
  const c = row.daily_ceiling_cents;
  const temperatures = (row.audience_temperatures ?? DEFAULT_RETARGET_AUDIENCE_TEMPERATURES).filter(
    (t): t is RetargetAudienceTemperature => t === "warm" || t === "hot",
  );
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    metaAdAccountId: row.meta_ad_account_id,
    productId: row.product_id,
    retargetMetaCampaignId: row.retarget_meta_campaign_id,
    retargetMetaAdsetId: row.retarget_meta_adset_id,
    dailyCeilingCents: typeof c === "string" ? Number(c) : c,
    audienceTemperatures: temperatures,
    defaultMetaPageId: row.default_meta_page_id,
    defaultMetaInstagramUserId: row.default_meta_instagram_user_id,
    isActive: row.is_active,
    notes: row.notes,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The EFFECTIVE retarget cohort for one `(workspace, meta_ad_account, product)` tuple.
 *
 * Resolution order (deliberately mirrors
 * [[./cold-scaler-cohort]] `getEffectiveMediaBuyerColdScalerCohort` +
 * [[../../../docs/brain/libraries/media-buyer-publish-gate]]
 * `getEffectiveMediaBuyerTestCohort` so the three cohort concepts have
 * identical semantics):
 *   1. `(metaAdAccountId, productId)` — most specific.
 *   2. `(metaAdAccountId, product NULL)` — the account default.
 *   3. `(account NULL, product NULL)` — the workspace-wide default.
 *
 * Returns `null` when no active row matches — the consumer then treats
 * "retarget absent" as the DEFAULT (the retarget rail is dormant until a row
 * is inserted). `productId` and `metaAdAccountId` are both optional; omitting
 * them collapses to the workspace-wide default.
 */
export async function getEffectiveRetargetCohort(
  admin: Admin,
  workspaceId: string,
  args: { metaAdAccountId?: string | null; productId?: string | null } = {},
): Promise<MediaBuyerRetargetCohort | null> {
  const { metaAdAccountId = null, productId = null } = args;
  const { data, error } = await admin
    .from("media_buyer_retarget_cohorts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);
  if (error) throw error;
  const rows = (data || []).map((r) => toRetargetCohort(r as MediaBuyerRetargetCohortRow));
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
  return rows.find((r) => r.metaAdAccountId === null && r.productId === null) ?? null;
}

/**
 * Enumerate every ACTIVE retarget cohort for one `(workspace, meta_ad_account)`
 * pair, sorted by `product_id` with nulls last — same shape as
 * [[./cold-scaler-cohort]] `listActiveColdScalerCohorts`. Consumed by the
 * Phase 2 retarget replenish sibling to iterate every active cohort for a
 * `(workspace, account)` pair. `metaAdAccountId=null` restricts to the
 * workspace-wide (null-account) rows.
 */
export async function listActiveRetargetCohorts(
  admin: Admin,
  args: { workspaceId: string; metaAdAccountId: string | null },
): Promise<MediaBuyerRetargetCohort[]> {
  const { data, error } = await admin
    .from("media_buyer_retarget_cohorts")
    .select("*")
    .eq("workspace_id", args.workspaceId)
    .eq("is_active", true);
  if (error) throw error;
  const rows = (data || [])
    .map((r) => toRetargetCohort(r as MediaBuyerRetargetCohortRow))
    .filter((r) => r.metaAdAccountId === args.metaAdAccountId);
  rows.sort((a, b) => {
    if (a.productId === b.productId) return 0;
    if (a.productId === null) return 1; // nulls last
    if (b.productId === null) return -1;
    return a.productId < b.productId ? -1 : 1;
  });
  return rows;
}

export interface ProvisionRetargetCohortOptions {
  workspaceId: string;
  metaAdAccountId?: string | null;
  productId?: string | null;
  retargetMetaCampaignId: string;
  retargetMetaAdsetId: string;
  dailyCeilingCents: number;
  audienceTemperatures?: RetargetAudienceTemperature[];
  notes?: string;
}

export interface ProvisionRetargetCohortResult {
  cohortId: string;
  retargetMetaCampaignId: string;
  retargetMetaAdsetId: string;
}

/**
 * Provision (or refresh) a workspace's retarget cohort for one
 * `(workspace, meta_ad_account, product)` tuple. Idempotent by tuple:
 * re-running RETIRES any prior active row at the SAME tuple, then inserts a
 * fresh active row with the canonical publish identity resolved via
 * [[./publish-identity]] `resolvePublishIdentity` — the shipped
 * all-product-ads-always-publish-under-the-superfoods-company-fb-page-and-instagram
 * Phase 1 chokepoint. A wrong or missing publish identity is structurally
 * impossible.
 *
 * The retarget adset + campaign are caller-provided (Meta ids the founder has
 * created via the (later Phase 2/3) admin surface or manually) — Phase 1 does
 * NOT mint the campaign/adset (unlike `provisionProductTestCohort`). The
 * retarget rail's minting flow lives in Phase 2/3.
 *
 * `audienceTemperatures` defaults to `['warm','hot']`. `dailyCeilingCents`
 * must be `> 0` (matches the CHECK on the table).
 */
export async function provisionRetargetCohort(
  admin: Admin,
  opts: ProvisionRetargetCohortOptions,
): Promise<ProvisionRetargetCohortResult> {
  if (!opts.retargetMetaCampaignId) throw new Error("provisionRetargetCohort: retargetMetaCampaignId required");
  if (!opts.retargetMetaAdsetId) throw new Error("provisionRetargetCohort: retargetMetaAdsetId required");
  if (!Number.isFinite(opts.dailyCeilingCents) || opts.dailyCeilingCents <= 0) {
    throw new Error("provisionRetargetCohort: dailyCeilingCents must be > 0");
  }

  const identity = resolvePublishIdentity(opts.workspaceId);
  const metaAdAccountId = opts.metaAdAccountId ?? null;
  const productId = opts.productId ?? null;
  const temperatures = opts.audienceTemperatures ?? DEFAULT_RETARGET_AUDIENCE_TEMPERATURES;
  if (!temperatures.length) throw new Error("provisionRetargetCohort: audienceTemperatures cannot be empty");

  let retire = admin
    .from("media_buyer_retarget_cohorts")
    .update({ is_active: false })
    .eq("workspace_id", opts.workspaceId)
    .eq("is_active", true);
  retire = metaAdAccountId === null
    ? retire.is("meta_ad_account_id", null)
    : retire.eq("meta_ad_account_id", metaAdAccountId);
  retire = productId === null
    ? retire.is("product_id", null)
    : retire.eq("product_id", productId);
  const { error: retireErr } = await retire;
  if (retireErr) throw retireErr;

  const row = {
    workspace_id: opts.workspaceId,
    meta_ad_account_id: metaAdAccountId,
    product_id: productId,
    retarget_meta_campaign_id: opts.retargetMetaCampaignId,
    retarget_meta_adset_id: opts.retargetMetaAdsetId,
    daily_ceiling_cents: opts.dailyCeilingCents,
    audience_temperatures: temperatures,
    default_meta_page_id: identity.pageId,
    default_meta_instagram_user_id: identity.instagramUserId,
    is_active: true,
    notes: opts.notes ?? null,
  };
  const { data, error } = await admin
    .from("media_buyer_retarget_cohorts")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) throw new Error(`retarget_cohort_insert_failed: ${error?.message ?? "no row"}`);
  return {
    cohortId: (data as { id: string }).id,
    retargetMetaCampaignId: opts.retargetMetaCampaignId,
    retargetMetaAdsetId: opts.retargetMetaAdsetId,
  };
}
