/**
 * Winning-creative detection — growth-winning-creative-amplifier Phase 1.
 *
 * Reads our own [[../../tables/meta_attribution_daily]] grouped by `(meta_ad_id, variant)` over a
 * trailing window, scores per-row attributed ROAS = `revenue_cents / attributed_spend_cents` (the
 * `(onsiteCents+amazonCents)/spend_cents` shape the spec calls for — Amazon halo applied as an
 * optional workspace-level multiplier since it is not attributable per Meta ad), filters by a
 * min-spend AND a min-ROAS floor, and returns the top-K winners with each one's source
 * [[../../tables/ad_campaigns]] + [[../../tables/product_ad_angles]] joined so Phase 2's amplifier
 * knows the archetype/angle to clone.
 *
 * STRICTLY OUR DATA — read only from `meta_attribution_daily` + the two joined source tables.
 * No external ad-intelligence integrations are read here (the audit-mandated assumption check
 * encoded in the spec's verification grep).
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_BLENDED_CAC_LTV_TARGET } from "@/lib/blended-cac-ltv";

type Admin = ReturnType<typeof createAdminClient>;

/** Default lookback window (14 days in ms) — wide enough for Meta's late attribution + first-touch backfill. */
export const DEFAULT_SINCE_MS = 14 * 86400 * 1000;

/** Default minimum attributed spend floor in cents ($50) — below this the per-row ROAS is too noisy to trust. */
export const DEFAULT_MIN_SPEND_CENTS = 5_000;

/**
 * Default ROAS floor multiplier applied to the workspace's blended CAC:LTV target — a "winner" must
 * clear `target × 1.2` so we only amplify creatives that beat the supervised setpoint with margin.
 * The spec mandates this 1.2× safety factor on the floor.
 */
export const ROAS_FLOOR_MARGIN = 1.2;

/** How many top-by-ROAS winners to return per detection pass. Configurable. */
export const DEFAULT_TOP_K = 10;

/** Sentinel for spend/revenue that couldn't be resolved to a lander variant — never a winner. */
const UNRESOLVED_VARIANT = "(unresolved)";

/** Inputs to `detectWinners`. All but `workspaceId` are optional with spec-defaulted floors. */
export interface DetectWinnersOptions {
  workspaceId: string;
  /** Lookback duration in milliseconds. Defaults to {@link DEFAULT_SINCE_MS} (14d). */
  sinceMs?: number;
  /** Min summed `attributed_spend_cents` per `(meta_ad_id, variant)` group. Defaults to {@link DEFAULT_MIN_SPEND_CENTS}. */
  minSpendCents?: number;
  /**
   * Optional explicit ROAS floor. When omitted, the floor defaults to the workspace's blended
   * CAC:LTV target × {@link ROAS_FLOOR_MARGIN}. When neither is set, falls back to
   * {@link DEFAULT_BLENDED_CAC_LTV_TARGET} × {@link ROAS_FLOOR_MARGIN}.
   */
  minRoas?: number;
  /** Override the workspace's blended CAC:LTV target (drives the default ROAS floor). */
  targetCacLtv?: number;
  /** Top-K winners by ROAS. Defaults to {@link DEFAULT_TOP_K}. */
  topK?: number;
  /**
   * Optional Amazon-halo multiplier applied uniformly to per-row onsite revenue before scoring —
   * the per-row analog of acquisition-roas's `(onsiteCents+amazonCents)/spend_cents`. Defaults to
   * `1` (no halo). The workspace-level halo lives in `acquisition-roas.ts` and is NOT computed
   * inline here to avoid coupling the detector to that pass.
   */
  amazonHaloMultiplier?: number;
  /** Override "now" — tests pin this so the window is deterministic. */
  nowMs?: number;
}

/** A single attribution row the detector reads off [[meta_attribution_daily]]. */
export interface WinnerAttributionRow {
  meta_ad_id: string;
  variant: string;
  ad_campaign_id: string | null;
  angle_id: string | null;
  sessions: number | null;
  attributed_spend_cents: number | null;
  /** onsite revenue per row — the `(onsiteCents)` half of the spec's ROAS numerator. */
  revenue_cents: number | null;
  snapshot_date: string;
}

/** A campaign row joined onto each winner so the amplifier knows the archetype/script to clone. */
export interface WinnerCampaign {
  id: string;
  name: string | null;
  product_id: string | null;
  variant_id: string | null;
  avatar_id: string | null;
  angle_id: string | null;
  script_text: string | null;
  hero_image_url: string | null;
  landing_url: string | null;
  composition: Record<string, unknown> | null;
  length_sec: number;
  scene_style: string | null;
  caption_style: string | null;
}

/** An angle row joined onto each winner so the amplifier knows the hook/hook_slug to clone. */
export interface WinnerAngle {
  id: string;
  hook_slug: string;
  lf8_slot: number;
  lead_benefit_anchor: string;
  hook_one_liner: string | null;
  meta_headline: string | null;
  meta_primary_text: string | null;
  meta_description: string | null;
}

/** One detected winner — a `(meta_ad_id, variant)` cell clearing both floors, with source joined. */
export interface DetectedWinner {
  workspaceId: string;
  metaAdId: string;
  variant: string;
  /** Sum of `attributed_spend_cents` across the window for this cell. */
  spendCents: number;
  /** Sum of `revenue_cents` (onsite) across the window for this cell. */
  onsiteCents: number;
  /** `onsiteCents × amazonHaloMultiplier` — the per-row halo'd numerator. */
  haloAdjustedRevenueCents: number;
  /** `haloAdjustedRevenueCents / spendCents`, rounded to 4 dp. */
  roas: number;
  /** Sum of `sessions` across the window for this cell. */
  sessions: number;
  /** Window boundaries used to score this cell (UTC `YYYY-MM-DD`, inclusive). */
  windowStart: string;
  windowEnd: string;
  /** Source campaign + angle joined off `meta_attribution_daily`. Null when the join can't resolve. */
  campaign: WinnerCampaign | null;
  angle: WinnerAngle | null;
}

/** Pure aggregator — group attribution rows by `(meta_ad_id, variant)` and score each cell. Exposed for tests. */
export interface GroupedCell {
  metaAdId: string;
  variant: string;
  spendCents: number;
  onsiteCents: number;
  sessions: number;
  /** First non-null `ad_campaign_id` seen in the group (dominant by row count, with ties broken on order). */
  adCampaignId: string | null;
  angleId: string | null;
}

/**
 * Group rows by `(meta_ad_id, variant)` and sum spend/revenue/sessions. Skips the `(unresolved)`
 * variant (never a winner — it carries the spend/revenue we couldn't attribute to a real lander).
 * Picks the dominant `ad_campaign_id` / `angle_id` per cell by row count so a stray null doesn't
 * orphan the join.
 */
export function groupAttributionRows(rows: WinnerAttributionRow[]): GroupedCell[] {
  const cells = new Map<string, GroupedCell & { campaignCounts: Map<string, number>; angleCounts: Map<string, number> }>();
  for (const r of rows) {
    if (!r.meta_ad_id || !r.variant || r.variant === UNRESOLVED_VARIANT) continue;
    const key = `${r.meta_ad_id}::${r.variant}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        metaAdId: r.meta_ad_id,
        variant: r.variant,
        spendCents: 0,
        onsiteCents: 0,
        sessions: 0,
        adCampaignId: null,
        angleId: null,
        campaignCounts: new Map(),
        angleCounts: new Map(),
      };
      cells.set(key, cell);
    }
    cell.spendCents += Number(r.attributed_spend_cents ?? 0);
    cell.onsiteCents += Number(r.revenue_cents ?? 0);
    cell.sessions += Number(r.sessions ?? 0);
    if (r.ad_campaign_id) {
      cell.campaignCounts.set(r.ad_campaign_id, (cell.campaignCounts.get(r.ad_campaign_id) ?? 0) + 1);
    }
    if (r.angle_id) {
      cell.angleCounts.set(r.angle_id, (cell.angleCounts.get(r.angle_id) ?? 0) + 1);
    }
  }
  const out: GroupedCell[] = [];
  for (const cell of cells.values()) {
    cell.adCampaignId = pickDominant(cell.campaignCounts);
    cell.angleId = pickDominant(cell.angleCounts);
    out.push({
      metaAdId: cell.metaAdId,
      variant: cell.variant,
      spendCents: cell.spendCents,
      onsiteCents: cell.onsiteCents,
      sessions: cell.sessions,
      adCampaignId: cell.adCampaignId,
      angleId: cell.angleId,
    });
  }
  return out;
}

function pickDominant(counts: Map<string, number>): string | null {
  let bestId: string | null = null;
  let bestCount = -1;
  for (const [id, c] of counts) {
    if (c > bestCount || (c === bestCount && bestId !== null && id < bestId)) {
      bestId = id;
      bestCount = c;
    }
  }
  return bestId;
}

/** Score one grouped cell — returns null when it fails either floor. Pure; exposed for tests. */
export function scoreCell(
  cell: GroupedCell,
  opts: { minSpendCents: number; minRoas: number; amazonHaloMultiplier: number },
): { roas: number; haloAdjustedRevenueCents: number } | null {
  if (cell.spendCents < opts.minSpendCents) return null;
  const haloAdjustedRevenueCents = Math.round(cell.onsiteCents * opts.amazonHaloMultiplier);
  if (cell.spendCents === 0) return null;
  const roas = Number((haloAdjustedRevenueCents / cell.spendCents).toFixed(4));
  if (roas < opts.minRoas) return null;
  return { roas, haloAdjustedRevenueCents };
}

/** UTC day string (`YYYY-MM-DD`) — matches the `meta_attribution_daily.snapshot_date` shape. */
function dayStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Detect winning creatives over the workspace's own attribution data. Top-K by ROAS, gated by
 * min-spend AND min-ROAS floors, with the source campaign + angle joined.
 */
export async function detectWinners(
  admin: Admin,
  opts: DetectWinnersOptions,
): Promise<DetectedWinner[]> {
  const sinceMs = opts.sinceMs ?? DEFAULT_SINCE_MS;
  const minSpendCents = opts.minSpendCents ?? DEFAULT_MIN_SPEND_CENTS;
  const targetCacLtv = opts.targetCacLtv ?? DEFAULT_BLENDED_CAC_LTV_TARGET;
  const minRoas = opts.minRoas ?? targetCacLtv * ROAS_FLOOR_MARGIN;
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const amazonHaloMultiplier = opts.amazonHaloMultiplier ?? 1;
  const nowMs = opts.nowMs ?? Date.now();
  const windowStart = dayStr(nowMs - sinceMs);
  const windowEnd = dayStr(nowMs);

  const { data: attrData } = await admin
    .from("meta_attribution_daily")
    .select(
      "meta_ad_id, variant, ad_campaign_id, angle_id, sessions, attributed_spend_cents, revenue_cents, snapshot_date",
    )
    .eq("workspace_id", opts.workspaceId)
    .gte("snapshot_date", windowStart)
    .lte("snapshot_date", windowEnd);
  const rows = (attrData || []) as WinnerAttributionRow[];
  if (rows.length === 0) return [];

  const cells = groupAttributionRows(rows);

  const scored: (DetectedWinner & { _adCampaignId: string | null; _angleId: string | null })[] = [];
  for (const cell of cells) {
    const score = scoreCell(cell, { minSpendCents, minRoas, amazonHaloMultiplier });
    if (!score) continue;
    scored.push({
      workspaceId: opts.workspaceId,
      metaAdId: cell.metaAdId,
      variant: cell.variant,
      spendCents: cell.spendCents,
      onsiteCents: cell.onsiteCents,
      haloAdjustedRevenueCents: score.haloAdjustedRevenueCents,
      roas: score.roas,
      sessions: cell.sessions,
      windowStart,
      windowEnd,
      campaign: null,
      angle: null,
      _adCampaignId: cell.adCampaignId,
      _angleId: cell.angleId,
    });
  }

  // Top-K by ROAS desc, tie-break by spend desc so a higher-confidence winner wins the tie.
  scored.sort((a, b) => (b.roas - a.roas) || (b.spendCents - a.spendCents));
  const top = scored.slice(0, topK);
  if (top.length === 0) return [];

  // Join campaigns + angles in two batched IN queries (avoid N+1).
  const campaignIds = Array.from(new Set(top.map((w) => w._adCampaignId).filter((x): x is string => !!x)));
  const angleIds = Array.from(new Set(top.map((w) => w._angleId).filter((x): x is string => !!x)));
  const campaignsById = new Map<string, WinnerCampaign>();
  const anglesById = new Map<string, WinnerAngle>();
  if (campaignIds.length > 0) {
    const { data: campaigns } = await admin
      .from("ad_campaigns")
      .select(
        "id, name, product_id, variant_id, avatar_id, angle_id, script_text, hero_image_url, landing_url, composition, length_sec, scene_style, caption_style",
      )
      .eq("workspace_id", opts.workspaceId)
      .in("id", campaignIds);
    for (const c of (campaigns || []) as WinnerCampaign[]) campaignsById.set(c.id, c);
  }
  if (angleIds.length > 0) {
    const { data: angles } = await admin
      .from("product_ad_angles")
      .select("id, hook_slug, lf8_slot, lead_benefit_anchor, hook_one_liner, meta_headline, meta_primary_text, meta_description")
      .eq("workspace_id", opts.workspaceId)
      .in("id", angleIds);
    for (const a of (angles || []) as WinnerAngle[]) anglesById.set(a.id, a);
  }

  return top.map((w) => {
    const { _adCampaignId, _angleId, ...rest } = w;
    return {
      ...rest,
      campaign: _adCampaignId ? campaignsById.get(_adCampaignId) ?? null : null,
      angle: _angleId ? anglesById.get(_angleId) ?? null : null,
    };
  });
}
