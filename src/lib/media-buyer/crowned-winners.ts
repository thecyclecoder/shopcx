/**
 * Media Buyer CROWNED WINNERS — durable per-workspace ledger of every test
 * adset the Media Buyer's crown detector graduated to "winner." Persists the
 * crown fact and (Phase 2) the reactivation-guard read.
 *
 * Introduced by [[../../../docs/brain/specs/media-buyer-persist-crowned-winners-and-guard-reactivation]]
 * Phase 1. Backs [[../../../docs/brain/tables/media_buyer_crowned_winners]].
 *
 * Consumers:
 *   • Bianca's Media Buyer pass — writes one marker per crowned winner via
 *     `recordCrownedWinner` right after `detectWinners` and `metaAdIdToAdsetId`
 *     resolve (agent.ts).
 *   • Recovered-CPA reactivation (Phase 2) — reads
 *     `listCrownedWinnerAdsetIds` and REMOVES those adset ids from the
 *     candidate set so a graduated winner is never resurrected regardless of
 *     pause provenance or recovered CPA.
 *   • Future graduate / re-test / replenish flows — MUST consult
 *     `listCrownedWinnerAdsetIds` before re-testing or reactivating a creative;
 *     that's the crown-marker contract this SDK enforces.
 *
 * The SDK is the ONLY allowed writer / reader of the table — CLAUDE.md
 * § "Raw .from(...) STOP" (a hand-rolled query against a wrong column silently
 * reads as empty). Every mutator here is idempotent; a crown-marker write is
 * safe to retry across Media Buyer passes.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** TS shape of a `media_buyer_crowned_winners` row (snake → camel). */
export interface MediaBuyerCrownedWinner {
  id: string;
  workspaceId: string;
  metaAdAccountId: string | null;
  productId: string | null;
  testMetaAdsetId: string;
  winningMetaAdId: string | null;
  crownedAt: string;
  graduatedAt: string | null;
  scalerMetaCampaignId: string | null;
  scalerMetaAdsetId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MediaBuyerCrownedWinnerRow {
  id: string;
  workspace_id: string;
  meta_ad_account_id: string | null;
  product_id: string | null;
  test_meta_adset_id: string;
  winning_meta_ad_id: string | null;
  crowned_at: string;
  graduated_at: string | null;
  scaler_meta_campaign_id: string | null;
  scaler_meta_adset_id: string | null;
  created_at: string;
  updated_at: string;
}

function toCrownedWinner(row: MediaBuyerCrownedWinnerRow): MediaBuyerCrownedWinner {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    metaAdAccountId: row.meta_ad_account_id,
    productId: row.product_id,
    testMetaAdsetId: row.test_meta_adset_id,
    winningMetaAdId: row.winning_meta_ad_id,
    crownedAt: row.crowned_at,
    graduatedAt: row.graduated_at,
    scalerMetaCampaignId: row.scaler_meta_campaign_id,
    scalerMetaAdsetId: row.scaler_meta_adset_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Record a crown-marker row for one test adset. Idempotent upsert on
 * `(workspace_id, test_meta_adset_id)`.
 *
 * The `ignoreDuplicates` semantics MATTER: once a row exists (crown fact
 * captured) we NEVER clobber `graduated_at` / `scaler_meta_campaign_id` /
 * `scaler_meta_adset_id`. Those columns are set by the (future) graduate flow;
 * a replay of Bianca's pass must not reset them. So the upsert intentionally
 * leaves an existing row untouched — the crown fact is captured on FIRST
 * detection, and every subsequent pass no-ops.
 */
export async function recordCrownedWinner(
  admin: Admin,
  args: {
    workspaceId: string;
    metaAdAccountId?: string | null;
    productId?: string | null;
    testMetaAdsetId: string;
    winningMetaAdId?: string | null;
  },
): Promise<void> {
  await admin
    .from("media_buyer_crowned_winners")
    .upsert(
      {
        workspace_id: args.workspaceId,
        meta_ad_account_id: args.metaAdAccountId ?? null,
        product_id: args.productId ?? null,
        test_meta_adset_id: args.testMetaAdsetId,
        winning_meta_ad_id: args.winningMetaAdId ?? null,
      },
      { onConflict: "workspace_id,test_meta_adset_id", ignoreDuplicates: true },
    );
}

/**
 * Return the `test_meta_adset_id` of every crowned winner for one workspace
 * (optionally narrowed to one Meta ad account). The reactivation guard consumes
 * this — any candidate adset in the list is excluded before the CPP recovery
 * loop.
 *
 * Returns bare Meta adset ids (strings). Empty array when the workspace has no
 * crowned winners yet.
 */
export async function listCrownedWinnerAdsetIds(
  admin: Admin,
  args: { workspaceId: string; metaAdAccountId?: string | null },
): Promise<string[]> {
  let q = admin
    .from("media_buyer_crowned_winners")
    .select("test_meta_adset_id")
    .eq("workspace_id", args.workspaceId);
  if (args.metaAdAccountId) q = q.eq("meta_ad_account_id", args.metaAdAccountId);
  const { data } = await q;
  const rows = (data ?? []) as Array<{ test_meta_adset_id: string }>;
  return rows.map((r) => r.test_meta_adset_id);
}

/**
 * Read one crown-marker row by its test adset id — the readback the (future)
 * graduate flow uses to stamp `graduated_at` + `scaler_meta_*` onto the SAME
 * row it earlier marked crowned. Returns `null` when no row exists.
 */
export async function getCrownedWinnerByTestAdset(
  admin: Admin,
  args: { workspaceId: string; testMetaAdsetId: string },
): Promise<MediaBuyerCrownedWinner | null> {
  const { data } = await admin
    .from("media_buyer_crowned_winners")
    .select(
      "id, workspace_id, meta_ad_account_id, product_id, test_meta_adset_id, winning_meta_ad_id, crowned_at, graduated_at, scaler_meta_campaign_id, scaler_meta_adset_id, created_at, updated_at",
    )
    .eq("workspace_id", args.workspaceId)
    .eq("test_meta_adset_id", args.testMetaAdsetId)
    .maybeSingle();
  if (!data) return null;
  return toCrownedWinner(data as MediaBuyerCrownedWinnerRow);
}
