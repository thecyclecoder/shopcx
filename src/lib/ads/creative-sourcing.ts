/**
 * creative-sourcing — the shared SDK for WHERE great ad ideas come from + HOW ads actually perform, so
 * the agents (Dahlia sources angles, Bianca reads signal) and Max (supervises) all call ONE surface
 * instead of re-deriving it from raw Meta/DB queries (CEO 2026-07-11). Three idea pools + one analyzer:
 *
 *   1. getProvenCompetitorAngles — the 276-strong [[../../tables/creative_skeletons]] library, RANKED by
 *      `days_running` (longevity = a competitor is profitably scaling it = a validated angle). e.g.
 *      "Meet Nature's Ozempic" (118d), "Nighttime BP Spikes GONE in 28 Days" (210d).
 *   2. getOurWinningAngles — our OWN best-performing ads, judged on the validated signals (low cost-per-ATC,
 *      low CPP) — "what works for US", the exploit seed.
 *   3. (web DR research — a future pool; stubbed as a TODO.)
 *
 *   analyzeAccountAds — the per-ad performance analyzer (spend, purchases, CPP, ATC, cost-per-ATC, CPM,
 *      CTR, reactions/saves/shares) validated on 99 historical ads: cost-per-ATC + CPM discriminate
 *      winners; CTR + engagement are TRAPS (losers click/react MORE). See [[meta-cpa-signal]] · [[creative-brief]].
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { getMetaUserToken } from "@/lib/meta-ads";
import { recordDirectorActivity } from "@/lib/director-activity";

type Admin = ReturnType<typeof createAdminClient>;
const GRAPH = "https://graph.facebook.com/v21.0";

async function graphGet(path: string, token: string): Promise<{ data?: Array<Record<string, unknown>> }> {
  const res = await fetch(`${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(`graph_${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}
const actionVal = (actions: unknown, types: string[]): number => {
  if (!Array.isArray(actions)) return 0;
  for (const t of types) { const m = (actions as Array<{ action_type: string; value: string }>).find((a) => a.action_type === t); if (m) return Number(m.value) || 0; }
  return 0;
};
const PURCHASE = ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"];
const ADD_TO_CART = ["add_to_cart", "omni_add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"];

// ── Pool 1: proven competitor angles ─────────────────────────────────────────
export interface CompetitorAngle {
  advertiser: string | null;
  hook: string | null;
  framework: string | null;
  mechanismClaim: string | null;
  proof: string | null;
  offer: string | null;
  daysRunning: number | null;
  heat: number | null;
  destinationDomain: string | null;
  imageUrl: string | null;
}

export interface CompetitorAngleOptions {
  /** Only angles a competitor has run at least this long (longevity = validated). Default 30. */
  minDaysRunning?: number;
  /** DELIBERATE per-product filter (CEO 2026-07-12): only skeletons scouted for THIS product's own
   *  competitors (`creative_skeletons.product_id`). This is how imitate reads a product's own shelf —
   *  strongly preferred over `niche`. When set, `niche` is ignored. */
  productId?: string;
  /** LEGACY substring filter on advertiser/hook/mechanism (e.g. "coffee", "weight"). Kept for callers
   *  that predate product tagging; superseded by `productId`. */
  niche?: string;
  limit?: number;
  /** dahlia-deeper-competitor-selection Phase 1 — raise the imitation bar. When true, the primary
   *  pool floors `days_running >= 60` AND filters `resume_advertising=true` (still running). If that
   *  deeply-proven pool is EMPTY for the product, fall back to the shallow 30d/no-resume pool AND
   *  return `usedFallback:true` + emit a `dahlia_deeply_proven_fallback` `director_activity` row so
   *  the fallback is VISIBLE (never silent). Callers that don't set this get the legacy 30d shape. */
  preferDeeplyProven?: boolean;
}

export interface ProvenAnglesResult {
  angles: CompetitorAngle[];
  /** True when `preferDeeplyProven` was requested, the 60d/still-running pool was EMPTY, and the
   *  returned `angles` came from the shallow 30d/no-resume fallback. Also surfaced in
   *  `director_activity` (`action_kind='dahlia_deeply_proven_fallback'`) so it's audit-visible. */
  usedFallback: boolean;
}

interface QueryOptions {
  minDaysRunning: number;
  requireStillRunning: boolean;
  productId?: string;
  niche?: string;
  limit: number;
}

/** Raw query — the shared pool reader used by both the legacy path and the two-tier
 *  deeply-proven path. Returns just the mapped rows; the two-tier logic + visible-fallback
 *  audit belong to `getProvenCompetitorAngles`. */
async function queryProvenAngles(admin: Admin, workspaceId: string, q: QueryOptions): Promise<CompetitorAngle[]> {
  let query = admin
    .from("creative_skeletons")
    .select("advertiser, hook, framework, mechanism_claim, proof, offer, days_running, heat, destination_domain, image_url, resume_advertising")
    .eq("workspace_id", workspaceId)
    .eq("status", "analyzed")
    .not("hook", "is", null)
    .gte("days_running", q.minDaysRunning)
    .order("days_running", { ascending: false, nullsFirst: false })
    .limit(q.limit);
  if (q.requireStillRunning) query = query.eq("resume_advertising", true);
  if (q.productId) query = query.eq("product_id", q.productId);
  else if (q.niche) query = query.or(`advertiser.ilike.%${q.niche}%,hook.ilike.%${q.niche}%,mechanism_claim.ilike.%${q.niche}%`);
  const { data } = await query;
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    advertiser: (r.advertiser as string | null) ?? null,
    hook: (r.hook as string | null) ?? null,
    framework: (r.framework as string | null) ?? null,
    mechanismClaim: (r.mechanism_claim as string | null) ?? null,
    proof: (r.proof as string | null) ?? null,
    offer: (r.offer as string | null) ?? null,
    daysRunning: r.days_running == null ? null : Number(r.days_running),
    heat: r.heat == null ? null : Number(r.heat),
    destinationDomain: (r.destination_domain as string | null) ?? null,
    imageUrl: (r.image_url as string | null) ?? null,
  }));
}

/** Ranked proven competitor angles from the creative-skeleton library — the strongest idea pool (real
 *  market-validated hooks, ranked by how long the competitor has kept spending on them). Pass `productId`
 *  to read exactly that product's deliberately-chosen competitor shelf (the imitate→innovate path).
 *
 *  Pass `preferDeeplyProven:true` (Dahlia's imitate-then-innovate stockProduct — Phase 1 of
 *  [[../../../docs/brain/specs/dahlia-deeper-competitor-selection.md]]) to raise the bar: the primary
 *  pool becomes `days_running >= 60` + `resume_advertising=true`. On an EMPTY deeply-proven pool the
 *  function falls back to the shallow 30d/no-resume pool, sets `usedFallback:true`, AND emits a
 *  `dahlia_deeply_proven_fallback` `director_activity` row so a thin-shelf product's fallback is
 *  audit-visible (never silent). */
export async function getProvenCompetitorAngles(
  admin: Admin,
  workspaceId: string,
  opts: CompetitorAngleOptions = {},
): Promise<ProvenAnglesResult> {
  const shallowMinDays = opts.minDaysRunning ?? 30;
  const limit = opts.limit ?? 40;

  if (opts.preferDeeplyProven) {
    const deep = await queryProvenAngles(admin, workspaceId, {
      minDaysRunning: Math.max(60, shallowMinDays),
      requireStillRunning: true,
      productId: opts.productId,
      niche: opts.niche,
      limit,
    });
    if (deep.length > 0) return { angles: deep, usedFallback: false };

    // Empty deeply-proven pool → fall back visibly. Best-effort audit write; a director_activity
    // insert crash must NOT starve Dahlia of its shelf (mirrors recordDirectorActivity contract).
    const fallback = await queryProvenAngles(admin, workspaceId, {
      minDaysRunning: shallowMinDays,
      requireStillRunning: false,
      productId: opts.productId,
      niche: opts.niche,
      limit,
    });
    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: "growth",
      actionKind: "dahlia_deeply_proven_fallback",
      specSlug: "dahlia-deeper-competitor-selection",
      reason: `deeply-proven pool empty (${Math.max(60, shallowMinDays)}d + still-running) for ${
        opts.productId ? `product ${opts.productId}` : opts.niche ? `niche "${opts.niche}"` : "workspace-wide"
      } — fell back to the ${shallowMinDays}d/no-resume pool (${fallback.length} angle${fallback.length === 1 ? "" : "s"}). A thin competitor shelf, not silence.`,
      metadata: {
        product_id: opts.productId ?? null,
        niche: opts.niche ?? null,
        deeply_proven_min_days: Math.max(60, shallowMinDays),
        fallback_min_days: shallowMinDays,
        fallback_pool_size: fallback.length,
        autonomous: true,
      },
    }).catch((e) => {
      console.warn("dahlia_deeply_proven_fallback_activity_failed", {
        workspaceId,
        productId: opts.productId ?? null,
        err: e instanceof Error ? e.message : String(e),
      });
    });
    return { angles: fallback, usedFallback: true };
  }

  const angles = await queryProvenAngles(admin, workspaceId, {
    minDaysRunning: shallowMinDays,
    requireStillRunning: false,
    productId: opts.productId,
    niche: opts.niche,
    limit,
  });
  return { angles, usedFallback: false };
}

// ── The performance analyzer (per-ad, Meta ground truth) ─────────────────────
export interface AdPerformance {
  name: string;
  effectiveStatus: string;
  spendCents: number;
  impressions: number;
  purchases: number;
  addToCart: number;
  /** validated leading signal: spend ÷ add_to_cart (cents), null if no ATC. */
  costPerAtcCents: number | null;
  /** cost per purchase (cents), null if none. */
  cppCents: number | null;
  /** validated: spend per 1000 impressions (cents). */
  cpmCents: number;
  ctrPct: number;
  reactions: number;
  saves: number;
  shares: number;
}

/** Per-ad performance for an account (Meta ground truth) with the FULL validated indicator set. `datePreset`
 *  defaults to lifetime (`maximum`). Reactions/CTR are included for visibility but are TRAPS — winners are
 *  chosen on cost-per-ATC + CPM (proven on 99 historical ads). */
export async function analyzeAccountAds(token: string, bareMetaAccountId: string, opts: { datePreset?: string } = {}): Promise<AdPerformance[]> {
  const preset = opts.datePreset ?? "maximum";
  const res = await graphGet(`act_${bareMetaAccountId}/ads?fields=name,effective_status,insights.date_preset(${preset}){spend,impressions,ctr,actions}&limit=300`, token);
  const out: AdPerformance[] = [];
  for (const ad of (res.data ?? []) as Array<Record<string, unknown>>) {
    const ins = (ad.insights as { data?: Array<Record<string, unknown>> } | undefined)?.data?.[0];
    if (!ins) continue;
    const spend = Number(ins.spend ?? 0), imp = Number(ins.impressions ?? 0);
    const pur = actionVal(ins.actions, PURCHASE), atc = actionVal(ins.actions, ADD_TO_CART);
    out.push({
      name: String(ad.name ?? "").slice(0, 60),
      effectiveStatus: String(ad.effective_status ?? ""),
      spendCents: Math.round(spend * 100),
      impressions: imp,
      purchases: pur,
      addToCart: atc,
      costPerAtcCents: atc > 0 ? Math.round((spend / atc) * 100) : null,
      cppCents: pur > 0 ? Math.round((spend / pur) * 100) : null,
      cpmCents: imp > 0 ? Math.round((spend / imp) * 1000 * 100) : 0,
      ctrPct: Number(ins.ctr ?? 0),
      reactions: actionVal(ins.actions, ["post_reaction"]),
      saves: actionVal(ins.actions, ["onsite_conversion.post_save"]),
      shares: actionVal(ins.actions, ["post"]),
    });
  }
  return out;
}

// ── Pool 3: our own winning angles ───────────────────────────────────────────
export interface OurWinningAd extends AdPerformance {
  isCrownEligible: boolean; // CPP <= maxCpaCents AND spend >= minSpendCents
  isCandidate: boolean; // CPP <= maxCpaCents (converting), not yet at the spend floor
}

/** Our OWN best-performing ads for an account, ranked by cost-per-ATC then CPP — "what works for US".
 *  The exploit seed: these are the concepts/creatives to make variations of. */
export async function getOurWinningAngles(
  admin: Admin,
  workspaceId: string,
  bareMetaAccountId: string,
  opts: { maxCpaCents?: number; minSpendCents?: number } = {},
): Promise<OurWinningAd[]> {
  const token = await getMetaUserToken(workspaceId);
  if (!token) return [];
  const maxCpa = opts.maxCpaCents ?? 15000, minSpend = opts.minSpendCents ?? 45000;
  const ads = await analyzeAccountAds(token, bareMetaAccountId);
  return ads
    .filter((a) => a.purchases > 0 || a.addToCart > 0)
    .map((a) => ({ ...a, isCrownEligible: a.cppCents != null && a.cppCents <= maxCpa && a.spendCents >= minSpend, isCandidate: a.cppCents != null && a.cppCents <= maxCpa }))
    .sort((a, b) => (a.costPerAtcCents ?? 9e9) - (b.costPerAtcCents ?? 9e9) || (a.cppCents ?? 9e9) - (b.cppCents ?? 9e9));
}
