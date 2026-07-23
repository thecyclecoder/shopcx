/**
 * Media Buyer CROWNED WINNERS — durable per-workspace ledger of every test
 * adset the Media Buyer's crown detector graduated to "winner." Persists the
 * crown fact, the reactivation-guard read, and (via the exploit-tracking
 * columns) the per-winner strike/hit/exhaust counters that drive Dahlia's
 * explore/exploit split on crown.
 *
 * Introduced by [[../../../docs/brain/specs/media-buyer-persist-crowned-winners-and-guard-reactivation]]
 * Phase 1. Exploit tracking added by
 * [[../../../docs/brain/specs/media-buyer-explore-exploit-split-on-crown]]
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
 *   • Dahlia's replenish (explore/exploit split spec, Phase 2) — reads
 *     `listActiveWinnersForProduct` to allocate exploit slots best-CAC-first
 *     and calls `incrementExploitSpawned` per spawn / `recordExploitHit` on a
 *     promising-or-better verdict / `markExploitExhausted` on an operator
 *     override. When all a product's winners are exhausted the reader returns
 *     empty ⇒ the split reverts to 4-explore / 0-exploit.
 *
 * The SDK is the ONLY allowed writer / reader of the table — CLAUDE.md
 * § "Raw .from(...) STOP" (a hand-rolled query against a wrong column silently
 * reads as empty). Every mutator here is idempotent; a crown-marker write is
 * safe to retry across Media Buyer passes.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Consecutive dud exploit clones (spawned since the last hit) that mark a
 * crowned winner exploit-exhausted. Once tripped, the winner drops out of
 * `listActiveWinnersForProduct` and Phase 2 stops allocating it exploit slots
 * (a `recordExploitHit` clears both the strike counter and the exhausted flag;
 * a NEW crown on a different test adset re-arms exploit fresh via its own row).
 */
export const EXPLOIT_EXHAUST_STRIKES = 4;

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
  exploitSpawned: number;
  exploitHits: number;
  exploitExhausted: boolean;
  exploitExhaustedAt: string | null;
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
  exploit_spawned: number;
  exploit_hits: number;
  exploit_exhausted: boolean;
  exploit_exhausted_at: string | null;
  created_at: string;
  updated_at: string;
}

const CROWNED_WINNER_COLUMNS =
  "id, workspace_id, meta_ad_account_id, product_id, test_meta_adset_id, winning_meta_ad_id, crowned_at, graduated_at, scaler_meta_campaign_id, scaler_meta_adset_id, exploit_spawned, exploit_hits, exploit_exhausted, exploit_exhausted_at, created_at, updated_at";

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
    exploitSpawned: row.exploit_spawned,
    exploitHits: row.exploit_hits,
    exploitExhausted: row.exploit_exhausted,
    exploitExhaustedAt: row.exploit_exhausted_at,
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
    .select(CROWNED_WINNER_COLUMNS)
    .eq("workspace_id", args.workspaceId)
    .eq("test_meta_adset_id", args.testMetaAdsetId)
    .maybeSingle();
  if (!data) return null;
  return toCrownedWinner(data as MediaBuyerCrownedWinnerRow);
}

/**
 * Bump the source winner's strike counter (clones spawned SINCE the last hit).
 * When the counter reaches `EXPLOIT_EXHAUST_STRIKES` (4) we also flip
 * `exploit_exhausted = true` and stamp `exploit_exhausted_at = now()` so
 * `listActiveWinnersForProduct` drops the row on the very next Phase-2 pass.
 *
 * `by` is the number of exploit variants spawned in THIS Media Buyer pass
 * against the source winner (Phase 2 allocates round-robin best-CAC-first so
 * one pass can bump the same winner by 1 or 2). Idempotent-per-call in the
 * sense that recording no spawn is a no-op — callers pass a positive `by`.
 */
export async function incrementExploitSpawned(
  admin: Admin,
  args: { workspaceId: string; testMetaAdsetId: string; by: number },
): Promise<void> {
  if (!Number.isFinite(args.by) || args.by <= 0) return;
  const { data: current } = await admin
    .from("media_buyer_crowned_winners")
    .select("exploit_spawned, exploit_hits")
    .eq("workspace_id", args.workspaceId)
    .eq("test_meta_adset_id", args.testMetaAdsetId)
    .maybeSingle();
  if (!current) return;
  const nextSpawned = ((current as { exploit_spawned: number }).exploit_spawned ?? 0) + args.by;
  const nextHits = (current as { exploit_hits: number }).exploit_hits ?? 0;
  const nowExhausted = nextSpawned >= EXPLOIT_EXHAUST_STRIKES && nextHits === 0;
  const update: Record<string, unknown> = { exploit_spawned: nextSpawned };
  if (nowExhausted) {
    update.exploit_exhausted = true;
    update.exploit_exhausted_at = new Date().toISOString();
  }
  await admin
    .from("media_buyer_crowned_winners")
    .update(update)
    .eq("workspace_id", args.workspaceId)
    .eq("test_meta_adset_id", args.testMetaAdsetId);
}

/**
 * Credit an exploit hit — a variant clone reached promising-or-better. Bumps
 * `exploit_hits`, RESETS `exploit_spawned` to 0 (strikes accumulate only
 * between hits), and clears `exploit_exhausted` so the winner re-enters the
 * exploit rotation on the next pass. A dud/testing outcome contributes no
 * reset — its spawn already counted a strike when Phase 2 spawned it.
 */
export async function recordExploitHit(
  admin: Admin,
  args: { workspaceId: string; testMetaAdsetId: string },
): Promise<void> {
  const { data: current } = await admin
    .from("media_buyer_crowned_winners")
    .select("exploit_hits")
    .eq("workspace_id", args.workspaceId)
    .eq("test_meta_adset_id", args.testMetaAdsetId)
    .maybeSingle();
  if (!current) return;
  const nextHits = ((current as { exploit_hits: number }).exploit_hits ?? 0) + 1;
  await admin
    .from("media_buyer_crowned_winners")
    .update({
      exploit_hits: nextHits,
      exploit_spawned: 0,
      exploit_exhausted: false,
      exploit_exhausted_at: null,
    })
    .eq("workspace_id", args.workspaceId)
    .eq("test_meta_adset_id", args.testMetaAdsetId);
}

/**
 * Explicitly mark a crowned winner exploit-exhausted (drops out of
 * `listActiveWinnersForProduct`). `incrementExploitSpawned` already flips this
 * flag when the strike counter tops `EXPLOIT_EXHAUST_STRIKES`; this fn is the
 * escape hatch for cases where the caller wants to hard-exhaust a winner
 * without a spawn (e.g. an operator override or a follow-up spec's revert
 * path).
 */
export async function markExploitExhausted(
  admin: Admin,
  args: { workspaceId: string; testMetaAdsetId: string },
): Promise<void> {
  await admin
    .from("media_buyer_crowned_winners")
    .update({
      exploit_exhausted: true,
      exploit_exhausted_at: new Date().toISOString(),
    })
    .eq("workspace_id", args.workspaceId)
    .eq("test_meta_adset_id", args.testMetaAdsetId);
}

/**
 * Return every non-exhausted crown-marker row for one product (within one Meta
 * ad account). Phase 2 sorts these best-CAC-first (via the testing-results/CPA
 * read at the call site) and allocates the 2 exploit slots 1-per-winner
 * round-robin: 1 winner ⇒ both slots off it, 2+ winners ⇒ 1 each (top 2).
 *
 * Empty array ⇒ product has no active winners ⇒ Phase 2 falls back to
 * `DEFAULT_TEST_COHORT_TARGET=4` explore / 0 exploit.
 */
export async function listActiveWinnersForProduct(
  admin: Admin,
  args: { workspaceId: string; metaAdAccountId: string; productId: string },
): Promise<MediaBuyerCrownedWinner[]> {
  const { data } = await admin
    .from("media_buyer_crowned_winners")
    .select(CROWNED_WINNER_COLUMNS)
    .eq("workspace_id", args.workspaceId)
    .eq("meta_ad_account_id", args.metaAdAccountId)
    .eq("product_id", args.productId)
    .eq("exploit_exhausted", false);
  const rows = (data ?? []) as MediaBuyerCrownedWinnerRow[];
  return rows.map(toCrownedWinner);
}
