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
  /** Case-insensitive substring filter on advertiser/hook/mechanism — e.g. "weight", "coffee", "energy". */
  niche?: string;
  limit?: number;
}

/** Ranked proven competitor angles from the creative-skeleton library — the strongest idea pool (real
 *  market-validated hooks, ranked by how long the competitor has kept spending on them). */
export async function getProvenCompetitorAngles(admin: Admin, workspaceId: string, opts: CompetitorAngleOptions = {}): Promise<CompetitorAngle[]> {
  let q = admin
    .from("creative_skeletons")
    .select("advertiser, hook, framework, mechanism_claim, proof, offer, days_running, heat, destination_domain, image_url")
    .eq("workspace_id", workspaceId)
    .eq("status", "analyzed")
    .not("hook", "is", null)
    .gte("days_running", opts.minDaysRunning ?? 30)
    .order("days_running", { ascending: false, nullsFirst: false })
    .limit(opts.limit ?? 40);
  if (opts.niche) q = q.or(`advertiser.ilike.%${opts.niche}%,hook.ilike.%${opts.niche}%,mechanism_claim.ilike.%${opts.niche}%`);
  const { data } = await q;
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
