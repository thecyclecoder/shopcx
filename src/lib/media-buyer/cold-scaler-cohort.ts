/**
 * Media Buyer COLD-SCALER cohort — the SCALER-rail sibling of the test-cohort
 * SDK ([[../../../docs/brain/libraries/media-buyer-publish-gate]]
 * `getEffectiveMediaBuyerTestCohort`). Reads [[../../../docs/brain/tables/media_buyer_cold_scaler_cohorts]]
 * with typed row → object mapping, precedence resolution, and enumeration.
 *
 * Introduced by Bianca goal M4 ([[../../../docs/brain/specs/bianca-cold-scaler-cohort-and-daily-ceiling]]).
 * Consumers — arming gate, CAC:LTV sensor, graduate-crowned-winners — all read
 * this SDK to know whether a scaler cohort exists for a
 * `(workspace, meta_ad_account, product)` tuple, what its daily ceiling is,
 * and whether it is active.
 *
 * The SDK is the only allowed entry point for reading the cohort — the CLAUDE.md
 * "Raw .from(...) STOP" rule forbids a hand-rolled select against the table
 * (a wrong column name silently reads as empty).
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** The TS shape of a `media_buyer_cold_scaler_cohorts` row (snake → camel; bigint → number). */
export interface MediaBuyerColdScalerCohort {
  id: string;
  workspaceId: string;
  metaAdAccountId: string | null;
  productId: string | null;
  scalerMetaCampaignId: string | null;
  dailyScalerCeilingCents: number;
  isActive: boolean;
  notes: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MediaBuyerColdScalerCohortRow {
  id: string;
  workspace_id: string;
  meta_ad_account_id: string | null;
  product_id: string | null;
  scaler_meta_campaign_id: string | null;
  daily_scaler_ceiling_cents: number | string;
  is_active: boolean;
  notes: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

function toColdScalerCohort(row: MediaBuyerColdScalerCohortRow): MediaBuyerColdScalerCohort {
  const c = row.daily_scaler_ceiling_cents;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    metaAdAccountId: row.meta_ad_account_id,
    productId: row.product_id,
    scalerMetaCampaignId: row.scaler_meta_campaign_id,
    dailyScalerCeilingCents: typeof c === "string" ? Number(c) : c,
    isActive: row.is_active,
    notes: row.notes,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The EFFECTIVE cold-scaler cohort for one `(workspace, meta_ad_account, product)` tuple.
 *
 * Resolution order (deliberately mirrors
 * [[media-buyer-publish-gate]] `getEffectiveMediaBuyerTestCohort` so the two
 * cohort concepts have identical semantics):
 *   1. `(metaAdAccountId, productId)` — most specific.
 *   2. `(metaAdAccountId, product NULL)` — the account default.
 *   3. `(account NULL, product NULL)` — the workspace-wide default.
 *
 * Returns `null` when no active row matches — the consumer then treats "scaler
 * absent" as the DEFAULT (per Bianca M4: the scaler surface is dormant until a
 * row is inserted). `productId` and `metaAdAccountId` are both optional; omitting
 * them collapses to the workspace-wide default.
 */
export async function getEffectiveMediaBuyerColdScalerCohort(
  admin: Admin,
  workspaceId: string,
  args: { metaAdAccountId?: string | null; productId?: string | null },
): Promise<MediaBuyerColdScalerCohort | null> {
  const { metaAdAccountId = null, productId = null } = args;
  const { data, error } = await admin
    .from("media_buyer_cold_scaler_cohorts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);
  if (error) throw error;
  const rows = (data || []).map((r) => toColdScalerCohort(r as MediaBuyerColdScalerCohortRow));
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
 * Fetch ONE cold-scaler cohort by id, scoped to the workspace. Consumed by
 * the CAC:LTV sensor orchestrator ([[media-buyer__cold-scaler-cac-ltv-sensor]]
 * `runColdScalerCacLtvSensor`) to resolve the `scaler_meta_campaign_id` +
 * `meta_ad_account_id` for a passed-in `coldScalerCohortId`. Returns `null`
 * when no row matches (`workspace_id` mismatch or missing id) or the row is
 * dormant (`is_active=false`) — the sensor treats a dormant/absent cohort as
 * "nothing to sense" and writes an empty-metrics snapshot with a flag.
 */
export async function getMediaBuyerColdScalerCohortById(
  admin: Admin,
  args: { workspaceId: string; id: string },
): Promise<MediaBuyerColdScalerCohort | null> {
  const { data, error } = await admin
    .from("media_buyer_cold_scaler_cohorts")
    .select("*")
    .eq("workspace_id", args.workspaceId)
    .eq("id", args.id)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return toColdScalerCohort(data as MediaBuyerColdScalerCohortRow);
}

/**
 * Enumerate every ACTIVE scaler cohort for one `(workspace, meta_ad_account)`
 * pair, sorted by `product_id` with nulls last — same shape as the
 * `readActiveCohortProductIds` pattern the Phase 3 media-buyer dispatcher uses
 * over the test-cohort table.
 *
 * `metaAdAccountId=null` restricts to the workspace-wide (null-account) rows.
 */
/**
 * Compare-and-set writer for `scaler_meta_campaign_id` — Bianca M4 payoff spec
 * ([[../../../docs/brain/specs/bianca-cold-scaler-graduate-crowned-winners-to-advantage-plus-new-customers]] Phase 1).
 *
 * Called by `executeGraduateActionAgainstMeta` (Phase 3) after
 * `getOrCreateColdScalerCampaign` mints (or finds) the cohort's cold-scaler
 * Meta campaign. The `.eq("scaler_meta_campaign_id", null)` guard makes the
 * write a COMPARE-AND-SET so two concurrent graduate executors cannot
 * double-stamp — the second one no-ops (no rows updated) and the caller
 * simply re-reads via `getEffectiveMediaBuyerColdScalerCohort` /
 * `getMediaBuyerColdScalerCohortById` to see the id the first executor
 * persisted.
 *
 * Returns the number of rows updated (0 = someone else already stamped,
 * 1 = we stamped). Throws on any Supabase error.
 */
export async function setColdScalerCampaignId(
  admin: Admin,
  args: { cohortId: string; scalerMetaCampaignId: string },
): Promise<{ stamped: number }> {
  const { data, error } = await admin
    .from("media_buyer_cold_scaler_cohorts")
    .update({
      scaler_meta_campaign_id: args.scalerMetaCampaignId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.cohortId)
    .is("scaler_meta_campaign_id", null)
    .select("id");
  if (error) throw error;
  return { stamped: (data || []).length };
}

export async function listActiveColdScalerCohorts(
  admin: Admin,
  args: { workspaceId: string; metaAdAccountId: string | null },
): Promise<MediaBuyerColdScalerCohort[]> {
  const { data, error } = await admin
    .from("media_buyer_cold_scaler_cohorts")
    .select("*")
    .eq("workspace_id", args.workspaceId)
    .eq("is_active", true);
  if (error) throw error;
  const rows = (data || [])
    .map((r) => toColdScalerCohort(r as MediaBuyerColdScalerCohortRow))
    .filter((r) => r.metaAdAccountId === args.metaAdAccountId);
  rows.sort((a, b) => {
    if (a.productId === b.productId) return 0;
    if (a.productId === null) return 1; // nulls last
    if (b.productId === null) return -1;
    return a.productId < b.productId ? -1 : 1;
  });
  return rows;
}
