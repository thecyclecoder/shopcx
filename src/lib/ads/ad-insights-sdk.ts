/**
 * ad-insights-sdk — the one place ad-performance data is read, so no caller hand-rolls a
 * metaGraphRequest or re-implements purchase counting. It composes two sources by DESTINATION:
 *
 *   • SPEND — always from our own DB ([[meta_attribution_daily]]), synced daily, no API cost.
 *   • CONVERSIONS — destination-aware:
 *       – lander-routed ad (`advertorial_page_id` set) → our DB's sessions/orders/roas are valid.
 *       – Shopify-PDP-routed ad (`advertorial_page_id` null) → our internal order-match CANNOT
 *         attribute it, so META is the source of truth. (Future: reconcile PDP orders via
 *         Shopify's own reporting — stubbed, see reconcilePdpOrdersFromShopify.)
 *   • FUNNEL micro-metrics (impressions, link CTR, add-to-cart — the leading indicators) — only
 *     Meta carries them, fetched on demand.
 *
 * ⚠ Purchase counting: Meta's `actions[]` reports a purchase under BOTH `purchase` (the omni total
 * the dashboard "Purchases" column shows) AND `offsite_conversion.fb_pixel_purchase` (the pixel
 * subset). SUMMING them double-counts. countPurchases() reads the SINGLE canonical `purchase`
 * field — the value that reconciles with the Ads Manager export. (2026-07-09: a sum bug reported
 * skeptic-v3 as 2 purchases when the dashboard showed 1.)
 *
 * READ-ONLY. See [[../../../docs/brain/reference/meta-scaling-methodology.md]] · [[./meta-insights]].
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { metaGraphRequest } from "@/lib/meta/api";
import { getMonthlyChurn, blendedLifetimeOrders } from "@/lib/ltv";

type Admin = ReturnType<typeof createAdminClient>;

/** The one purchase action_type that matches the Ads Manager "Purchases" column. NEVER also add
 *  `offsite_conversion.fb_pixel_purchase` — that double-counts the same conversions. */
export const META_PURCHASE_ACTION = "purchase";

export interface MetaAction { action_type: string; value: string }

/** Value of a single Meta action_type from an actions[] array (0 if absent). */
export function countAction(actions: unknown, type: string): number {
  if (!Array.isArray(actions)) return 0;
  const a = (actions as MetaAction[]).find((x) => x.action_type === type);
  return a ? Number(a.value) : 0;
}

/** Canonical purchase count — the deduplicated `purchase` metric, matching the dashboard. */
export function countPurchases(actions: unknown): number {
  return countAction(actions, META_PURCHASE_ACTION);
}

export type Destination = "shopify_pdp" | "lander" | "unknown";

export interface AdInsight {
  adId: string;
  name: string;
  campaign: string;
  spend: number;
  impressions: number;
  frequency: number;
  linkClicks: number;
  linkCtr: number; // outbound/link CTR %
  cpc: number;
  cpm: number;
  landingPageViews: number;
  addToCart: number;
  initiateCheckout: number;
  purchases: number; // canonical (single field)
  revenue: number;
  destination: Destination;
  conversionSource: "meta" | "db"; // where purchases/orders came from
}

const META_GRAPH_MAX_RETRIES = 4;

/** Fetch ad-level insights for an account, with pagination + rate-limit (code 4/17/613/80004)
 *  backoff. Returns normalized rows; purchases via the single canonical field. */
export async function fetchMetaAdInsights(
  token: string,
  accountId: string,
  opts: { datePreset?: string; campaignContains?: string } = {},
): Promise<Map<string, AdInsight>> {
  const params: Record<string, string> = {
    level: "ad",
    fields: "ad_id,ad_name,campaign_name,spend,impressions,frequency,inline_link_clicks,inline_link_click_ctr,cpc,cpm,actions",
    date_preset: opts.datePreset ?? "last_30d",
    limit: "200",
  };
  if (opts.campaignContains) {
    params.filtering = JSON.stringify([{ field: "campaign.name", operator: "CONTAIN", value: opts.campaignContains }]);
  }
  const out = new Map<string, AdInsight>();
  let path: string | null = `/act_${accountId.replace(/^act_/, "")}/insights`;
  let firstParams: Record<string, string> | undefined = params;
  while (path) {
    let attempt = 0;
    let page: { data?: unknown[]; paging?: { next?: string } } | null = null;
    for (;;) {
      try {
        // firstParams on the first call; subsequent pages use the full `next` URL (no params).
        page = (firstParams
          ? await metaGraphRequest(token, path, firstParams)
          : await metaGraphRequest(token, path)) as { data?: unknown[]; paging?: { next?: string } };
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const rateLimited = /request limit reached|\(#(4|17|80004|613)\)|"code":(4|17|80004|613)/.test(msg);
        if (rateLimited && attempt < META_GRAPH_MAX_RETRIES) {
          const waitMs = 2000 * 2 ** attempt; // 2s, 4s, 8s, 16s
          await new Promise((r) => setTimeout(r, waitMs));
          attempt++;
          continue;
        }
        throw e;
      }
    }
    for (const raw of page.data ?? []) {
      const r = raw as Record<string, unknown>;
      const adId = String(r.ad_id ?? "");
      out.set(adId, {
        adId,
        name: String(r.ad_name ?? ""),
        campaign: String(r.campaign_name ?? ""),
        spend: Number(r.spend ?? 0),
        impressions: Number(r.impressions ?? 0),
        frequency: Number(r.frequency ?? 0),
        linkClicks: Number(r.inline_link_clicks ?? 0),
        linkCtr: Number(r.inline_link_click_ctr ?? 0),
        cpc: Number(r.cpc ?? 0),
        cpm: Number(r.cpm ?? 0),
        landingPageViews: countAction(r.actions, "landing_page_view"),
        addToCart: countAction(r.actions, "add_to_cart"),
        initiateCheckout: countAction(r.actions, "initiate_checkout"),
        purchases: countPurchases(r.actions),
        revenue: 0, // filled by DB where lander-attributed; Meta purchase value can be added if needed
        destination: "unknown",
        conversionSource: "meta",
      });
    }
    // Meta's `next` is a full URL; strip the graph base so metaGraphRequest can re-prefix it.
    const next = page.paging?.next ?? null;
    path = next ? next.replace(/^https:\/\/graph\.facebook\.com\/v\d+(\.\d+)?/, "") : null;
    firstParams = undefined;
  }
  return out;
}

/** Per-ad DB facts: spend (authoritative), destination (advertorial_page_id → lander vs PDP), and
 *  our attributed orders/revenue/roas (valid ONLY for lander-routed ads). Keyed by meta_ad_id. */
export async function getDbAdFacts(
  admin: Admin,
  workspaceId: string,
  opts: { sinceDate?: string } = {},
): Promise<Map<string, { spend: number; sessions: number; orders: number; revenue: number; destination: Destination }>> {
  let q = admin
    .from("meta_attribution_daily")
    .select("meta_ad_id, attributed_spend_cents, sessions, orders, revenue_cents, advertorial_page_id")
    .eq("workspace_id", workspaceId);
  if (opts.sinceDate) q = q.gte("snapshot_date", opts.sinceDate);
  const { data } = await q;
  const out = new Map<string, { spend: number; sessions: number; orders: number; revenue: number; destination: Destination }>();
  for (const raw of data ?? []) {
    const r = raw as { meta_ad_id: string; attributed_spend_cents: number | null; sessions: number | null; orders: number | null; revenue_cents: number | null; advertorial_page_id: string | null };
    const cur = out.get(r.meta_ad_id) ?? { spend: 0, sessions: 0, orders: 0, revenue: 0, destination: "shopify_pdp" as Destination };
    cur.spend += (r.attributed_spend_cents ?? 0) / 100;
    cur.sessions += r.sessions ?? 0;
    cur.orders += r.orders ?? 0;
    cur.revenue += (r.revenue_cents ?? 0) / 100;
    if (r.advertorial_page_id) cur.destination = "lander"; // any lander-routed day marks it lander-attributable
    out.set(r.meta_ad_id, cur);
  }
  return out;
}

export interface CacThresholds { ltv: number; targetCac: number; killCac: number; basis: string }
export const TARGET_CAC_LTV = 3;
export const KILL_CAC_LTV = 1.5;
/** CEO strategic crown/target CAC (Dylan, 2026-07-12). The crown line is a STRATEGY setpoint, not an
 *  LTV function: an ad crowns at CPA ≤ $150 over ≥ $450 spend (the VERDICT_FLOOR_SPEND). Kill stays
 *  LTV-derived (LTV/1.5) so retention still auto-widens the hold band. Was LTV/3 (≈$110 at current
 *  LTV), which under-called winners vs the operating rule. */
export const CROWN_TARGET_CAC = 150;
const DOCUMENTED_LTV_FALLBACK = 424;

/** Crown/target CAC = the $150 CEO setpoint; kill = live LTV/1.5 from the latest complete monthly snapshot. */
export async function resolveCacThresholds(admin: Admin, workspaceId: string, override?: number): Promise<CacThresholds> {
  if (override && override > 0) return { ltv: override, targetCac: CROWN_TARGET_CAC, killCac: override / KILL_CAC_LTV, basis: `override $${override}` };
  let ltv = DOCUMENTED_LTV_FALLBACK, basis = `documented fallback $${DOCUMENTED_LTV_FALLBACK} (live snapshot thin)`;
  try {
    const churn = await getMonthlyChurn({ admin, workspaceId, trailingMonths: null });
    const { data } = await admin
      .from("monthly_revenue_snapshots")
      .select("subscription_rate, total_revenue_cents, total_count, month")
      .eq("workspace_id", workspaceId).eq("is_complete", true)
      .order("month", { ascending: false }).limit(1);
    const s = (data ?? [])[0] as { subscription_rate: number; total_revenue_cents: number; total_count: number; month: string } | undefined;
    if (s && s.total_count > 0 && churn.monthly_churn > 0) {
      const subRate = Number(s.subscription_rate) / 100;
      const aov = s.total_revenue_cents / 100 / s.total_count;
      const orders = blendedLifetimeOrders(subRate, churn.monthly_churn);
      ltv = aov * orders;
      basis = `live: AOV $${aov.toFixed(0)} × ${orders.toFixed(1)} orders (sub ${(subRate * 100).toFixed(0)}%, churn ${(churn.monthly_churn * 100).toFixed(1)}%, ${s.month})`;
    }
  } catch { /* fall through to documented */ }
  return { ltv, targetCac: CROWN_TARGET_CAC, killCac: ltv / KILL_CAC_LTV, basis };
}

export type Verdict = "winner" | "hold" | "kill" | "below_floor";
export const VERDICT_FLOOR_SPEND = 450;
/** Crown floor — a winner needs ≥ this many purchases (CEO decision tree 2026-07-12). ~3 purchases
 *  ($450 at a $150 CPA) is statistical noise; a 3–7 purchase converter reads as HOLD, not a crown. */
export const MIN_PURCHASES = 8;
/** Decision deadline — an ad at/past this spend that never crowned is RETIRED (free the test slot).
 *  ~8 test-days at $150/day. Mirrors iteration_policies.max_test_spend_cents. */
export const DECISION_DEADLINE_SPEND = 1200;
const FATIGUE_FREQ_ACT = 4.5;

/** Classify one ad against the decision-tree bands (CEO 2026-07-12): crown (CPA ≤ target AND ≥ 8
 *  purchases) · HOLD (converting, CPA ≤ kill/profit-floor, not yet crown-qualified) · slow-kill (CPA >
 *  kill) · dud (no purchases past the floor) · deadline-retire (spent the full runway without crowning).
 *  Kill stays fast; only CROWNING is patient. See docs/brain/reference/meta-scaling-methodology.md. */
export function classifyAd(ad: AdInsight, t: CacThresholds): { verdict: Verdict; fatigued: boolean; cpa: number | null; action: string } {
  const cpa = ad.purchases > 0 ? ad.spend / ad.purchases : null;
  const fatigued = ad.frequency >= FATIGUE_FREQ_ACT && ad.linkCtr < 1.0;
  const crownQualified = cpa != null && cpa <= t.targetCac && ad.purchases >= MIN_PURCHASES;
  // Decision deadline — full runway spent without crowning → retire the slot.
  if (ad.spend >= DECISION_DEADLINE_SPEND && !crownQualified) return { verdict: "kill", fatigued, cpa, action: `RETIRE — $${ad.spend.toFixed(0)} spent, never crowned (deadline)` };
  if (ad.spend < VERDICT_FLOOR_SPEND) return { verdict: "below_floor", fatigued, cpa, action: `still testing — under $${VERDICT_FLOOR_SPEND} verdict floor` };
  if (crownQualified) return { verdict: "winner", fatigued, cpa, action: fatigued ? "WINNER but FATIGUED — refresh before scaling" : "WINNER — duplicate into scaler, +20%/3–4d while ROAS holds" };
  if (cpa == null) return { verdict: "kill", fatigued, cpa, action: `KILL — 0 purchases at $${ad.spend.toFixed(0)}` };
  if (cpa > t.killCac) return { verdict: "kill", fatigued, cpa, action: `KILL — CPA $${cpa.toFixed(0)} > kill $${t.killCac.toFixed(0)}` };
  return { verdict: "hold", fatigued, cpa, action: `HOLD — CPA $${cpa.toFixed(0)}, ${ad.purchases}/${MIN_PURCHASES} purchases; keep testing` };
}

/** Merge DB spend/destination onto Meta insights (Meta = conversion truth for PDP; DB spend is
 *  authoritative). Returns Meta rows enriched with destination + DB spend where present. */
export function mergeDbFacts(meta: Map<string, AdInsight>, db: Map<string, { spend: number; orders: number; revenue: number; destination: Destination }>): AdInsight[] {
  for (const [adId, ad] of meta) {
    const f = db.get(adId);
    if (f) {
      ad.destination = f.destination;
      if (f.destination === "lander" && f.orders > 0) { ad.purchases = f.orders; ad.revenue = f.revenue; ad.conversionSource = "db"; }
    }
  }
  return [...meta.values()];
}

/** FUTURE: attribute Shopify-PDP orders back to their meta_ad_id via Shopify order reporting
 *  (UTM / landing-site ad params), closing the gap where our internal order-match can't. Stub. */
export async function reconcilePdpOrdersFromShopify(_admin: Admin, _workspaceId: string): Promise<void> {
  throw new Error("reconcilePdpOrdersFromShopify: not yet implemented — PDP conversions currently come from Meta");
}
