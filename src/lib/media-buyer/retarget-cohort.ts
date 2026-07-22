/**
 * retarget-cohort — the SDK chokepoint for `public.media_buyer_retarget_cohorts`
 * (retarget-campaign-warm-hot-mixed-content Phase 1).
 *
 * The Media Buyer's THIRD Meta campaign: a dedicated RETARGET campaign with ONE lean
 * consolidated ad set carrying WARM + HOT MIXED creative (sourced from creatives Dahlia
 * tags `warm`/`hot`). Distinct from [[./publish-gate]] `getEffectiveMediaBuyerTestCohort`
 * (the COLD test rail behind Bianca's replenish loop) — this rail never touches the
 * cold-only invariant of that loop; it reads its own `audience_temperatures` whitelist
 * (default `{warm,hot}`) and publishes into its own consolidated adset.
 *
 * `getEffectiveRetargetCohort` resolves the most-specific active row for a
 * `(workspace, account, product)` tuple with the SAME coalesce/fallback precedence the
 * test-cohort resolver uses (product-exact → account null-product default → workspace-wide
 * null-account default). `provisionRetargetCohort` idempotently upserts one active row and
 * delegates the canonical Facebook Page + Instagram identity resolution to
 * [[./publish-identity]] `resolvePublishIdentity` — every product's ads (cold OR retarget)
 * always publish under the SAME Superfoods Company brand identity.
 *
 * See docs/brain/tables/media_buyer_retarget_cohorts.md ·
 * docs/brain/libraries/media-buyer-retarget-cohort.md.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { resolvePublishIdentity, type PublishIdentity } from "@/lib/media-buyer/publish-identity";

type Admin = ReturnType<typeof createAdminClient>;

/** The temperature bands the retarget rail carries. The cold test rail owns `cold`; the
 *  retarget rail owns the WARM + HOT MIX so the two rails never contend for a creative. */
export type RetargetTemperature = "warm" | "hot";

/** The default mix a retarget cohort carries when the caller doesn't override it. Mirrors the
 *  migration's `audience_temperatures text[] not null default '{warm,hot}'`. */
export const DEFAULT_RETARGET_TEMPERATURES: readonly RetargetTemperature[] = ["warm", "hot"];

/** The TS shape of a `media_buyer_retarget_cohorts` row (snake → camel; bigint → number). */
export interface RetargetCohort {
  id: string;
  workspaceId: string;
  metaAdAccountId: string | null;
  productId: string | null;
  /** The dedicated retarget Meta campaign the consolidated adset lives under. */
  retargetMetaCampaignId: string;
  /** The ONE consolidated retarget ad set every warm/hot creative publishes into. */
  retargetMetaAdsetId: string;
  /** Daily USD ceiling (cents) capping the consolidated adset's spend. */
  dailyCeilingCents: number;
  /** The warm/hot mix this rail carries (defaults to `['warm','hot']`). */
  audienceTemperatures: string[];
  isActive: boolean;
  notes: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RetargetCohortRow {
  id: string;
  workspace_id: string;
  meta_ad_account_id: string | null;
  product_id: string | null;
  retarget_meta_campaign_id: string;
  retarget_meta_adset_id: string;
  daily_ceiling_cents: number | string;
  audience_temperatures: string[] | null;
  is_active: boolean;
  notes: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

function toCohort(row: RetargetCohortRow): RetargetCohort {
  const c = row.daily_ceiling_cents;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    metaAdAccountId: row.meta_ad_account_id,
    productId: row.product_id ?? null,
    retargetMetaCampaignId: row.retarget_meta_campaign_id,
    retargetMetaAdsetId: row.retarget_meta_adset_id,
    dailyCeilingCents: typeof c === "string" ? Number(c) : c,
    audienceTemperatures:
      Array.isArray(row.audience_temperatures) && row.audience_temperatures.length
        ? row.audience_temperatures
        : [...DEFAULT_RETARGET_TEMPERATURES],
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
 * Resolution order (mirrors [[./publish-gate]] `getEffectiveMediaBuyerTestCohort`): the
 * product-specific `(account, productId)` row wins, then falls back to the null-product
 * account default, then to the workspace-wide null-account default. Returns null when no
 * active row exists (the retarget gate then REFUSES a publish — no configured cohort = no
 * autonomous retarget go-live).
 *
 * `productId` is optional: omitting it (or passing null) returns the null-product account
 * default, so a workspace that never grew a product dimension behaves identically.
 */
export async function getEffectiveRetargetCohort(
  admin: Admin,
  workspaceId: string,
  args: { metaAdAccountId?: string | null; productId?: string | null } = {},
): Promise<RetargetCohort | null> {
  const { metaAdAccountId = null, productId = null } = args;
  const { data, error } = await admin
    .from("media_buyer_retarget_cohorts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);
  if (error) throw error;
  const rows = (data || []).map((r) => toCohort(r as RetargetCohortRow));
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

export interface ProvisionRetargetCohortOptions {
  workspaceId: string;
  /** `meta_ad_accounts.id` (our UUID) — the cohort's account FK. NULL = workspace-wide default. */
  metaAdAccountUuid?: string | null;
  /** `products.id` (our UUID). NULL = the (workspace, account) default retarget cohort. */
  productId?: string | null;
  /** The dedicated retarget Meta campaign id (the caller find-or-creates it on Meta). */
  retargetMetaCampaignId: string;
  /** The ONE consolidated retarget ad set id under that campaign. */
  retargetMetaAdsetId: string;
  /** Daily USD ceiling in cents (> 0). */
  dailyCeilingCents: number;
  /** The warm/hot mix this cohort carries — defaults to `['warm','hot']`. */
  audienceTemperatures?: RetargetTemperature[];
  notes?: string;
  updatedBy?: string | null;
}

export interface ProvisionRetargetCohortResult {
  cohortId: string;
  publishIdentity: PublishIdentity;
}

/**
 * Provision (or refresh) a retarget cohort. Idempotent on (workspace, account, product):
 * re-running retires any prior active row for the scope and inserts a fresh one. Delegates the
 * canonical Facebook Page + Instagram identity resolution to [[./publish-identity]]
 * `resolvePublishIdentity` so the retarget campaign can never diverge from the CEO's single
 * Superfoods Company brand identity (the same rail the cold rail's `buildReplenishJobInsert`
 * honors). Creates NO Meta objects and spends nothing — the caller supplies the already-created
 * retarget campaign + consolidated adset ids.
 */
export async function provisionRetargetCohort(
  admin: Admin,
  opts: ProvisionRetargetCohortOptions,
): Promise<ProvisionRetargetCohortResult> {
  if (!(opts.dailyCeilingCents > 0)) throw new Error("daily_ceiling_cents must be > 0");
  // Resolve (and validate) the canonical publish identity up front — a mis-scoped workspace
  // throws here rather than silently provisioning a retarget cohort under the wrong brand page.
  const publishIdentity = resolvePublishIdentity(opts.workspaceId);

  const metaAdAccountUuid = opts.metaAdAccountUuid ?? null;
  const productId = opts.productId ?? null;
  const temperatures = (opts.audienceTemperatures ?? [...DEFAULT_RETARGET_TEMPERATURES]) as string[];

  const row = {
    workspace_id: opts.workspaceId,
    meta_ad_account_id: metaAdAccountUuid,
    product_id: productId,
    retarget_meta_campaign_id: opts.retargetMetaCampaignId,
    retarget_meta_adset_id: opts.retargetMetaAdsetId,
    daily_ceiling_cents: opts.dailyCeilingCents,
    audience_temperatures: temperatures,
    is_active: true,
    notes: opts.notes ?? `retarget cohort — warm+hot mix, $${(opts.dailyCeilingCents / 100).toFixed(0)}/day ceiling on one consolidated adset.`,
    updated_by: opts.updatedBy ?? null,
  };

  // One active retarget cohort per (workspace, account, product): retire any prior active row,
  // then insert fresh. `.is(...)` handles the NULL account/product scopes cleanly.
  let retire = admin
    .from("media_buyer_retarget_cohorts")
    .update({ is_active: false })
    .eq("workspace_id", opts.workspaceId)
    .eq("is_active", true);
  retire = metaAdAccountUuid
    ? retire.eq("meta_ad_account_id", metaAdAccountUuid)
    : retire.is("meta_ad_account_id", null);
  retire = productId ? retire.eq("product_id", productId) : retire.is("product_id", null);
  await retire;

  const { data, error } = await admin
    .from("media_buyer_retarget_cohorts")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) throw new Error(`retarget_cohort_insert_failed: ${error?.message ?? "no row"}`);

  return { cohortId: (data as { id: string }).id, publishIdentity };
}
