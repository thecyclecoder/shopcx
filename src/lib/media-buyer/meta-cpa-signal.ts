/**
 * meta-cpa-signal — the Meta-native trusted signal for the Media Buyer (Bianca).
 *
 * CEO decision (2026-07-10): for Meta-based media buying we TRUST Meta's own reported conversions.
 * Our internal order-match can't resolve Shopify-destined ad revenue (Meta owns that truth), so the
 * winner/loser signal reads Meta's REPORTED numbers — spend + purchases per adset from
 * [[../../tables/iteration_scorecards_daily]] (level='adset', sourced from [[../../tables/meta_insights_daily]]).
 *
 *   • crown a winner  = Meta-reported CPA (spend ÷ purchases) ≤ `crownMaxCpaCents` AND spend ≥ `crownMinSpendCents`
 *   • trim a loser early = spend ≥ `earlyTrimMinSpendCents` AND (no purchases yet, or CPA already past the crown CPA)
 *
 * The old ROAS-floor path ([[../ads/winning-creative-detect]] `detectWinners` over
 * [[../../tables/meta_attribution_daily]]) stays the default; only a policy with
 * `trust_meta_reported_signal=true` uses this. See [[media-buyer-agent]].
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import type { DetectedWinner, WinnerCampaign, WinnerAngle } from "@/lib/ads/winning-creative-detect";
import type { MediaBuyerLoser } from "@/lib/media-buyer/agent";

type Admin = ReturnType<typeof createAdminClient>;

/** How stale the newest adset scorecard may be before we treat the Meta signal as absent (dormant). */
export const META_SIGNAL_MAX_AGE_DAYS = 3;

interface AdsetScorecard {
  id: string;
  object_id: string; // the Meta adset id
  label: string | null;
  /** CUMULATIVE (lifetime) test spend in cents — Σ meta_insights_daily, NOT a rolling window. The crown
   *  floor ("$450 in spend") is a verdict floor: an adset that has spent $450 TOTAL has earned a call. */
  spend_cents: number;
  purchases: number;
  revenue_cents: number;
  atc_rate: number | null;
  snapshot_date: string;
}

/** How far back "lifetime" reaches — 180d comfortably covers any test adset's whole life (tests are new)
 *  while bounding the row scan. Cumulative spend, not a rolling verdict window. */
const LIFETIME_LOOKBACK_DAYS = 180;

/**
 * The currently-ACTIVE adsets for the account, each with its CUMULATIVE (lifetime) spend / purchases /
 * revenue summed from [[../../tables/meta_insights_daily]] — Meta's reported numbers. The active set +
 * scorecard id/label come from the latest [[../../tables/iteration_scorecards_daily]] snapshot; the totals
 * are overlaid from the full insights history so the crown floor measures cumulative test spend (a $450
 * verdict floor reached over the test's life), never a rolling 7-day window that a low-budget adset caps
 * out below.
 */
async function activeAdsetLifetimeMetrics(admin: Admin, workspaceId: string, metaAdAccountId: string): Promise<AdsetScorecard[]> {
  const { data: latest } = await admin
    .from("iteration_scorecards_daily")
    .select("snapshot_date")
    .eq("workspace_id", workspaceId)
    .eq("meta_ad_account_id", metaAdAccountId)
    .eq("level", "adset")
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const snapshotDate = (latest as { snapshot_date?: string } | null)?.snapshot_date;
  if (!snapshotDate) return [];

  // Active adsets (id + label) from the latest snapshot.
  const { data: scRows } = await admin
    .from("iteration_scorecards_daily")
    .select("id, object_id, label, atc_rate")
    .eq("workspace_id", workspaceId)
    .eq("meta_ad_account_id", metaAdAccountId)
    .eq("level", "adset")
    .eq("snapshot_date", snapshotDate)
    .eq("effective_status", "ACTIVE");
  const active = ((scRows ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id), object_id: String(r.object_id), label: (r.label as string | null) ?? null, atc_rate: r.atc_rate == null ? null : Number(r.atc_rate),
  }));
  if (!active.length) return [];

  // Cumulative lifetime totals per active adset from the insights history.
  const sinceIso = new Date(Date.now() - LIFETIME_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const adsetIds = active.map((a) => a.object_id);
  const { data: ins } = await admin
    .from("meta_insights_daily")
    .select("meta_object_id, spend_cents, purchases, revenue_cents")
    .eq("workspace_id", workspaceId)
    .eq("meta_ad_account_id", metaAdAccountId)
    .eq("level", "adset")
    .in("meta_object_id", adsetIds)
    .gte("snapshot_date", sinceIso);
  const life = new Map<string, { spend: number; purch: number; rev: number }>();
  for (const r of (ins ?? []) as Array<Record<string, unknown>>) {
    const k = String(r.meta_object_id);
    const cur = life.get(k) ?? { spend: 0, purch: 0, rev: 0 };
    cur.spend += Number(r.spend_cents ?? 0);
    cur.purch += Number(r.purchases ?? 0);
    cur.rev += Number(r.revenue_cents ?? 0);
    life.set(k, cur);
  }

  return active.map((a) => {
    const l = life.get(a.object_id) ?? { spend: 0, purch: 0, rev: 0 };
    return { id: a.id, object_id: a.object_id, label: a.label, atc_rate: a.atc_rate, snapshot_date: snapshotDate, spend_cents: l.spend, purchases: l.purch, revenue_cents: l.rev };
  });
}

/** Is Meta's reported adset signal fresh enough to act on? (freshness replaces the internal-resolve
 *  coverage gate when trusting Meta.) `nowMs` overridable for tests. */
export async function hasFreshMetaSignal(admin: Admin, workspaceId: string, metaAdAccountId: string, nowMs: number = Date.now()): Promise<boolean> {
  const { data } = await admin
    .from("iteration_scorecards_daily")
    .select("snapshot_date")
    .eq("workspace_id", workspaceId)
    .eq("meta_ad_account_id", metaAdAccountId)
    .eq("level", "adset")
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const snapshotDate = (data as { snapshot_date?: string } | null)?.snapshot_date;
  if (!snapshotDate) return false;
  const ageMs = nowMs - new Date(`${snapshotDate}T00:00:00Z`).getTime();
  return ageMs <= META_SIGNAL_MAX_AGE_DAYS * 24 * 3600 * 1000;
}

/** Resolve a winning adset's dominant child ad + its source ad_campaign/angle (for the promote target +
 *  best-effort amplify). Campaign/angle are nullable — promote only needs the adset. */
async function resolveWinnerSource(
  admin: Admin,
  metaAdsetId: string,
): Promise<{ metaAdId: string; campaign: WinnerCampaign | null; angle: WinnerAngle | null }> {
  const { data: ads } = await admin
    .from("meta_ads")
    .select("meta_ad_id, spend_cents")
    .eq("meta_adset_id", metaAdsetId)
    .order("spend_cents", { ascending: false })
    .limit(1);
  const metaAdId = (ads as Array<{ meta_ad_id: string }> | null)?.[0]?.meta_ad_id ?? metaAdsetId;

  // ShopCX-published ads join back to ad_campaigns via ad_publish_jobs.meta_ad_id.
  let campaign: WinnerCampaign | null = null;
  let angle: WinnerAngle | null = null;
  const { data: pj } = await admin
    .from("ad_publish_jobs")
    .select("ad_campaign_id")
    .eq("meta_ad_id", metaAdId)
    .not("ad_campaign_id", "is", null)
    .limit(1)
    .maybeSingle();
  const adCampaignId = (pj as { ad_campaign_id?: string } | null)?.ad_campaign_id ?? null;
  if (adCampaignId) {
    const { data: c } = await admin
      .from("ad_campaigns")
      .select("id, name, product_id, angle_id")
      .eq("id", adCampaignId)
      .maybeSingle();
    const cc = c as { id: string; name: string | null; product_id: string | null; angle_id: string | null } | null;
    if (cc) {
      campaign = { id: cc.id, name: cc.name, product_id: cc.product_id, variant_id: null, avatar_id: null, angle_id: cc.angle_id, script_text: null, hero_image_url: null, landing_url: null, composition: null, length_sec: 0, scene_style: null, caption_style: null };
      if (cc.angle_id) {
        const { data: a } = await admin
          .from("product_ad_angles")
          .select("id, hook_slug, lf8_slot, lead_benefit_anchor, hook_one_liner, meta_headline, meta_primary_text, meta_description")
          .eq("id", cc.angle_id)
          .maybeSingle();
        angle = (a as WinnerAngle | null) ?? null;
      }
    }
  }
  return { metaAdId, campaign, angle };
}

export interface MetaCpaWinnerOptions {
  workspaceId: string;
  metaAdAccountId: string;
  crownMaxCpaCents: number;
  crownMinSpendCents: number;
  topK?: number;
}

/** Winners on Meta's reported signal: adsets with CPA ≤ crownMaxCpaCents AND spend ≥ crownMinSpendCents,
 *  ranked by CPA ascending, resolved into the DetectedWinner shape the plan/amplifier consume. */
export async function detectMetaCpaWinners(admin: Admin, opts: MetaCpaWinnerOptions): Promise<DetectedWinner[]> {
  const rows = await activeAdsetLifetimeMetrics(admin, opts.workspaceId, opts.metaAdAccountId);
  const qualifying = rows
    .filter((r) => r.purchases > 0 && r.spend_cents >= opts.crownMinSpendCents && r.spend_cents / r.purchases <= opts.crownMaxCpaCents)
    .sort((a, b) => a.spend_cents / a.purchases - b.spend_cents / b.purchases)
    .slice(0, opts.topK ?? 3);

  const winners: DetectedWinner[] = [];
  for (const r of qualifying) {
    const { metaAdId, campaign, angle } = await resolveWinnerSource(admin, r.object_id);
    const roas = r.spend_cents > 0 ? Number((r.revenue_cents / r.spend_cents).toFixed(4)) : 0;
    winners.push({
      workspaceId: opts.workspaceId,
      metaAdId,
      variant: "meta_reported",
      spendCents: r.spend_cents,
      onsiteCents: r.revenue_cents,
      haloAdjustedRevenueCents: r.revenue_cents,
      roas,
      sessions: 0,
      windowStart: r.snapshot_date,
      windowEnd: r.snapshot_date,
      campaign,
      angle,
    });
  }
  return winners;
}

export interface MetaCpaLoserOptions {
  workspaceId: string;
  metaAdAccountId: string;
  crownMaxCpaCents: number;
  earlyTrimMinSpendCents: number;
}

/** Losers on Meta's reported signal — trim early: an adset that has spent ≥ earlyTrimMinSpendCents with
 *  either no purchases yet OR a CPA already worse than the crown CPA is clearly not converting. Each
 *  loser cites its dominant child ad so the audit names the creative in decline. */
export async function detectMetaCpaLosers(admin: Admin, opts: MetaCpaLoserOptions): Promise<MediaBuyerLoser[]> {
  const rows = await activeAdsetLifetimeMetrics(admin, opts.workspaceId, opts.metaAdAccountId);
  const losing = rows.filter(
    (r) => r.spend_cents >= opts.earlyTrimMinSpendCents && (r.purchases === 0 || r.spend_cents / r.purchases > opts.crownMaxCpaCents),
  );
  const losers: MediaBuyerLoser[] = [];
  for (const r of losing) {
    const { data: ads } = await admin
      .from("meta_ads")
      .select("meta_ad_id, spend_cents")
      .eq("meta_adset_id", r.object_id)
      .order("spend_cents", { ascending: false })
      .limit(1);
    const sourceMetaAdId = (ads as Array<{ meta_ad_id: string }> | null)?.[0]?.meta_ad_id ?? r.object_id;
    losers.push({
      sourceMetaAdId,
      targetLevel: "adset",
      targetObjectId: r.object_id,
      roas: r.spend_cents > 0 ? Number((r.revenue_cents / r.spend_cents).toFixed(4)) : 0,
      spendCents: r.spend_cents,
      triggeringScorecardId: r.id,
    });
  }
  return losers;
}
