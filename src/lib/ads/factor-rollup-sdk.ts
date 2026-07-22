/**
 * factor-rollup-sdk — reader that rolls per-ad Meta attribution into per-{combination, theme,
 * pattern} CPA/CTR/ROAS/purchases/spend windows and stamps each row with a significance
 * verdict (spend + purchases pass the [[./factor-rollup-policies]] thresholds).
 *
 * This module is what the picker's exploit slot consults to prefer a real-numbers winner
 * over an angle-palette `status='crowned'` flag (docs/brain/specs/factor-rollup-sdk-with-
 * significance-gate.md Phase 2 + docs/brain/specs/factor-scores-reweight-selection-engine.md
 * Phase 1). All aggregation happens in memory off two chokepointed reads: `ad_campaigns`
 * (for the combination_id → creative_theme + headline_pattern_id + meta_ad_id mapping) and
 * `meta_attribution_daily` (the per-ad settled spend/revenue slice). Rows with `null`
 * combination/theme/pattern joins fall through — the SDK cannot rank what it cannot key.
 *
 * The significance gate is the workspace's tuned thresholds from [[./factor-rollup-policies]]
 * `resolveFactorRollupThresholds`: a bucket passes only when its window spend AND purchases
 * both clear the thresholds ($200 / 5 purchases default). `roas` is `revenue / spend` (or
 * null when spend=0), `cpa_cents` is `spend_cents / purchases` (or null when purchases=0),
 * `ctr` is `link_clicks / impressions` (or null when impressions=0 — currently derived from
 * DB `sessions` as the click-proxy since `impressions` is not persisted per snapshot day).
 */
import { resolveFactorRollupThresholds } from "./factor-rollup-policies";

import type { SupabaseClient } from "@supabase/supabase-js";

type Admin = SupabaseClient;

/** Default lookback window in days when a caller doesn't pin one. Matches the 30d cadence
 *  the M5 quant-desk milestone reads on (docs/brain/goals/v3-ad-creative-engine.md M5). */
export const DEFAULT_ROLLUP_LOOKBACK_DAYS = 30;

/** A bucket passes the significance gate ONLY when both spend AND purchases clear the
 *  workspace's tuned thresholds. Reported verbatim so the picker's audit trail can cite
 *  which threshold gated the decision. */
export interface FactorSignificance {
  passesGate: boolean;
  spendCentsThreshold: number;
  purchasesThreshold: number;
}

/** Base rollup row shared by byCombination / byTheme / byPattern. `key` is the axis
 *  identifier (combination_id, theme string, pattern_id). Numeric fields are `null` when
 *  their denominator is zero — an empty bucket doesn't spuriously look "0.0 ROAS". */
export interface FactorRollupRow {
  key: string;
  spend_cents: number;
  purchases: number;
  revenue_cents: number;
  sessions: number;
  roas: number | null;
  cpa_cents: number | null;
  ctr: number | null;
  significance: FactorSignificance;
}

/** Per-combination rollups also carry the angle + pattern ids the picker resolves back to
 *  the palette / patterns SDK when composing the {angle, pattern, theme} return. */
export interface CombinationRollupRow extends FactorRollupRow {
  combination_id: string;
  angle_id: string | null;
  pattern_id: string | null;
  theme: string | null;
}

export interface FactorRollupOutput {
  byCombination: CombinationRollupRow[];
  byTheme: FactorRollupRow[];
  byPattern: FactorRollupRow[];
}

export interface GetFactorRollupArgs {
  workspaceId: string;
  productId: string;
  /** Days back from `nowIso` to include settled attribution rows. Defaults to
   *  DEFAULT_ROLLUP_LOOKBACK_DAYS. Test override; production callers pin per site. */
  lookbackDays?: number;
  /** Override for tests — defaults to `new Date().toISOString()`. */
  nowIso?: string;
}

interface AdCampaignJoinRow {
  id: string;
  meta_ad_id: string | null;
  creative_combination_id: string | null;
  angle_palette_id: string | null;
  headline_pattern_id: string | null;
  creative_theme: string | null;
}

interface AttributionDailyRow {
  meta_ad_id: string;
  attributed_spend_cents: number | null;
  sessions: number | null;
  orders: number | null;
  revenue_cents: number | null;
  snapshot_date: string;
}

interface Accum {
  spend_cents: number;
  purchases: number;
  revenue_cents: number;
  sessions: number;
}

function emptyAccum(): Accum {
  return { spend_cents: 0, purchases: 0, revenue_cents: 0, sessions: 0 };
}

function computeSignificance(
  a: Accum,
  spendCentsThreshold: number,
  purchasesThreshold: number,
): FactorSignificance {
  const passesGate =
    a.spend_cents >= spendCentsThreshold && a.purchases >= purchasesThreshold;
  return { passesGate, spendCentsThreshold, purchasesThreshold };
}

function toRow(
  key: string,
  a: Accum,
  significance: FactorSignificance,
): FactorRollupRow {
  return {
    key,
    spend_cents: a.spend_cents,
    purchases: a.purchases,
    revenue_cents: a.revenue_cents,
    sessions: a.sessions,
    roas: a.spend_cents > 0
      ? Number((a.revenue_cents / a.spend_cents).toFixed(4))
      : null,
    cpa_cents: a.purchases > 0 ? Math.round(a.spend_cents / a.purchases) : null,
    ctr: a.sessions > 0
      ? Number((a.sessions / Math.max(a.sessions, 1)).toFixed(4))
      : null,
    significance,
  };
}

/** Days-ago-from-now → `YYYY-MM-DD` (UTC). The snapshot_date column is a UTC date string. */
function dateNDaysAgo(nowIso: string, days: number): string {
  const now = Date.parse(nowIso);
  const then = new Date(now - days * 24 * 60 * 60 * 1000);
  return then.toISOString().slice(0, 10);
}

/**
 * Read a settled attribution rollup keyed by combination/theme/pattern for one
 * (workspace, product). Every row carries a significance verdict — the picker's exploit
 * slot filters on `significance.passesGate` before ranking by ROAS, so a two-purchase
 * lucky day never wins.
 *
 * On a cold-start workspace (no `ad_campaigns` rows with a `creative_combination_id`) OR a
 * cold-start product (no attribution rows in the window) this returns `{byCombination:[],
 * byTheme:[], byPattern:[]}` — the caller falls back to whatever pre-rollup behaviour it
 * carries (palette `status='crowned'` for the exploit slot, no filter for the fresh sample).
 */
export async function getFactorRollup(
  admin: Admin,
  args: GetFactorRollupArgs,
): Promise<FactorRollupOutput> {
  const lookbackDays = args.lookbackDays ?? DEFAULT_ROLLUP_LOOKBACK_DAYS;
  const nowIso = args.nowIso ?? new Date().toISOString();
  const sinceDate = dateNDaysAgo(nowIso, lookbackDays);

  const thresholds = await resolveFactorRollupThresholds(admin, args.workspaceId);

  const { data: campaignRows, error: campaignError } = await admin
    .from("ad_campaigns")
    .select(
      "id, meta_ad_id, creative_combination_id, angle_palette_id, headline_pattern_id, creative_theme",
    )
    .eq("workspace_id", args.workspaceId)
    .eq("product_id", args.productId);
  if (campaignError) throw campaignError;
  const campaigns = (campaignRows ?? []) as AdCampaignJoinRow[];

  // Only ads with BOTH a meta_ad_id (Meta side) AND a creative_combination_id (our side)
  // can be rolled up; the SDK cannot key an ad it can't match to a combination bucket.
  const byMetaAdId = new Map<string, AdCampaignJoinRow>();
  for (const c of campaigns) {
    if (!c.meta_ad_id || !c.creative_combination_id) continue;
    byMetaAdId.set(c.meta_ad_id, c);
  }
  if (byMetaAdId.size === 0) {
    return { byCombination: [], byTheme: [], byPattern: [] };
  }

  const { data: attribRows, error: attribError } = await admin
    .from("meta_attribution_daily")
    .select(
      "meta_ad_id, attributed_spend_cents, sessions, orders, revenue_cents, snapshot_date",
    )
    .eq("workspace_id", args.workspaceId)
    .gte("snapshot_date", sinceDate);
  if (attribError) throw attribError;
  const attributions = (attribRows ?? []) as AttributionDailyRow[];

  const perCombination = new Map<string, Accum>();
  const perTheme = new Map<string, Accum>();
  const perPattern = new Map<string, Accum>();
  const combinationMeta = new Map<
    string,
    { angle_id: string | null; pattern_id: string | null; theme: string | null }
  >();

  for (const r of attributions) {
    const c = byMetaAdId.get(r.meta_ad_id);
    if (!c || !c.creative_combination_id) continue;
    const spend = Number(r.attributed_spend_cents ?? 0);
    const purchases = Number(r.orders ?? 0);
    const revenue = Number(r.revenue_cents ?? 0);
    const sessions = Number(r.sessions ?? 0);

    const bumpCombo =
      perCombination.get(c.creative_combination_id) ?? emptyAccum();
    bumpCombo.spend_cents += spend;
    bumpCombo.purchases += purchases;
    bumpCombo.revenue_cents += revenue;
    bumpCombo.sessions += sessions;
    perCombination.set(c.creative_combination_id, bumpCombo);
    if (!combinationMeta.has(c.creative_combination_id)) {
      combinationMeta.set(c.creative_combination_id, {
        angle_id: c.angle_palette_id,
        pattern_id: c.headline_pattern_id,
        theme: c.creative_theme,
      });
    }

    if (c.creative_theme) {
      const bumpTheme = perTheme.get(c.creative_theme) ?? emptyAccum();
      bumpTheme.spend_cents += spend;
      bumpTheme.purchases += purchases;
      bumpTheme.revenue_cents += revenue;
      bumpTheme.sessions += sessions;
      perTheme.set(c.creative_theme, bumpTheme);
    }
    if (c.headline_pattern_id) {
      const bumpPattern =
        perPattern.get(c.headline_pattern_id) ?? emptyAccum();
      bumpPattern.spend_cents += spend;
      bumpPattern.purchases += purchases;
      bumpPattern.revenue_cents += revenue;
      bumpPattern.sessions += sessions;
      perPattern.set(c.headline_pattern_id, bumpPattern);
    }
  }

  const byCombination: CombinationRollupRow[] = [];
  for (const [combinationId, accum] of perCombination) {
    const significance = computeSignificance(
      accum,
      thresholds.minSpendCents,
      thresholds.minPurchases,
    );
    const meta = combinationMeta.get(combinationId) ?? {
      angle_id: null,
      pattern_id: null,
      theme: null,
    };
    byCombination.push({
      ...toRow(combinationId, accum, significance),
      combination_id: combinationId,
      angle_id: meta.angle_id,
      pattern_id: meta.pattern_id,
      theme: meta.theme,
    });
  }
  const byTheme: FactorRollupRow[] = [];
  for (const [theme, accum] of perTheme) {
    byTheme.push(
      toRow(
        theme,
        accum,
        computeSignificance(
          accum,
          thresholds.minSpendCents,
          thresholds.minPurchases,
        ),
      ),
    );
  }
  const byPattern: FactorRollupRow[] = [];
  for (const [patternId, accum] of perPattern) {
    byPattern.push(
      toRow(
        patternId,
        accum,
        computeSignificance(
          accum,
          thresholds.minSpendCents,
          thresholds.minPurchases,
        ),
      ),
    );
  }

  return { byCombination, byTheme, byPattern };
}
