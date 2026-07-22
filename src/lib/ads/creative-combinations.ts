/**
 * creative-combinations — SDK chokepoint for the coverage ledger at the freshness grain
 * (`public.ad_creative_combinations`). One row per (workspace, product, angle × pattern) —
 * the "never ship the same ad twice" memory that carries `times_used` / `last_used_at` /
 * `status` for cooldown + coverage-before-repetition, plus the `campaign_id` perf link.
 *
 * All reads/writes of `ad_creative_combinations` route through here (never raw
 * `.from('ad_creative_combinations')` outside this file — shopcx no-raw-`.from()` rail).
 *
 * Phase-1 of the [[../../docs/brain/specs/selection-engine-coverage-ledger.md]] introduces
 * only the READER; writers (`upsertCombinationForPair` + `bumpCombinationUsed`) land with
 * the sibling [[../../docs/brain/specs/wire-engine-into-dahlia-author-path.md]] Phase 3.
 * See docs/brain/tables/ad_creative_combinations.md and docs/brain/libraries/creative-combinations.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type Admin = SupabaseClient;

export type CombinationStatus = "fresh" | "tested" | "crowned" | "retired";

export interface CreativeCombination {
  id: string;
  workspaceId: string;
  productId: string;
  angleId: string;
  patternId: string;
  timesUsed: number;
  lastUsedAt: string | null;
  status: CombinationStatus;
  campaignId: string | null;
}

interface CombinationRow {
  id: string;
  workspace_id: string;
  product_id: string;
  angle_id: string;
  pattern_id: string;
  times_used: number;
  last_used_at: string | null;
  status: string;
  campaign_id: string | null;
}

function toCombination(r: CombinationRow): CreativeCombination {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    productId: r.product_id,
    angleId: r.angle_id,
    patternId: r.pattern_id,
    timesUsed: r.times_used,
    lastUsedAt: r.last_used_at,
    status: r.status as CombinationStatus,
    campaignId: r.campaign_id,
  };
}

/**
 * List combination rows for a (workspace, product), optionally narrowed to a `status`.
 * The selector reads this then applies cooldown + palette + pattern joins in memory — one
 * place owns the freshness horizon (see [[selection-engine]] `COOLDOWN_DAYS`).
 */
export async function listCombinationsForProduct(
  admin: Admin,
  args: { workspaceId: string; productId: string; status?: CombinationStatus },
): Promise<CreativeCombination[]> {
  let q = admin
    .from("ad_creative_combinations")
    .select("*")
    .eq("workspace_id", args.workspaceId)
    .eq("product_id", args.productId);
  if (args.status) q = q.eq("status", args.status);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((r) => toCombination(r as CombinationRow));
}
