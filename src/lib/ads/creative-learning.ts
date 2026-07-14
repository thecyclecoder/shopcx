/**
 * creative-learning — the memory behind Dahlia's test selection (CEO 2026-07-10). Reads/writes
 * [[../../tables/creative_test_outcomes]] so the ad-creative loop:
 *   • explores by COMBINATION (angle × treatment), never retiring a concept after one loss — an angle
 *     only "stops working" once MULTIPLE distinct combinations have failed;
 *   • learns — aggregate win-rates per angle_key + per treatment bias which test ads to make from the start.
 *
 * A "combination" = `angle_key` (the concept) × `treatment` (the creative execution/archetype). The media
 * buyer stamps each row's outcome (won/lost/reactivated) once its test concludes — see [[media-buyer-agent]].
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** The creative treatments (execution formats) a concept can be tested in — each angle × treatment is a
 *  distinct combination, so one angle gets several shots before it's judged exhausted. */
export const TREATMENTS = ["before_after", "testimonial", "big_claim", "authority", "advertorial"] as const;
export type Treatment = (typeof TREATMENTS)[number];

/** A concept is only retired after this many DISTINCT combinations have lost — "a failed angle×image×
 *  audience is not a dead angle" (CEO). Below this, the angle stays eligible with a fresh combination. */
export const MAX_FAILED_COMBOS_BEFORE_RETIRE = 3;

/** Normalize an angle hook to its concept identity (what we explore/retire at the concept level). */
export function angleKey(hook: string): string {
  return hook.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
}

export interface AngleStat {
  angleKey: string;
  tried: number;      // distinct combinations generated for this concept
  won: number;
  lost: number;
  pending: number;
  triedTreatments: Set<Treatment>;
  /** true once ≥ MAX_FAILED_COMBOS_BEFORE_RETIRE combinations lost AND none won — the concept is exhausted. */
  retired: boolean;
}

export interface TreatmentStat {
  treatment: Treatment;
  won: number;
  lost: number;
  winRate: number | null; // won / (won+lost); null if never judged
}

export interface CreativeLearning {
  byAngle: Map<string, AngleStat>;
  byTreatment: Map<Treatment, TreatmentStat>;
  /** treatments ranked by historical win-rate (desc) — bias new combinations toward what wins. */
  bestTreatments: Treatment[];
}

/** Load the learning for a product — per-angle + per-treatment win/loss history. */
export async function loadCreativeLearning(admin: Admin, workspaceId: string, productId: string): Promise<CreativeLearning> {
  const { data } = await admin
    .from("creative_test_outcomes")
    .select("angle_key, treatment, outcome")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId);
  const rows = (data ?? []) as Array<{ angle_key: string; treatment: string; outcome: string }>;

  const byAngle = new Map<string, AngleStat>();
  const byTreatment = new Map<Treatment, TreatmentStat>();
  for (const t of TREATMENTS) byTreatment.set(t, { treatment: t, won: 0, lost: 0, winRate: null });

  for (const r of rows) {
    const a = byAngle.get(r.angle_key) ?? { angleKey: r.angle_key, tried: 0, won: 0, lost: 0, pending: 0, triedTreatments: new Set<Treatment>(), retired: false };
    a.tried += 1;
    if (TREATMENTS.includes(r.treatment as Treatment)) a.triedTreatments.add(r.treatment as Treatment);
    const tr = byTreatment.get(r.treatment as Treatment);
    if (r.outcome === "won" || r.outcome === "reactivated") { a.won += 1; if (tr) tr.won += 1; }
    else if (r.outcome === "lost") { a.lost += 1; if (tr) tr.lost += 1; }
    else a.pending += 1;
    byAngle.set(r.angle_key, a);
  }
  for (const a of byAngle.values()) a.retired = a.won === 0 && a.lost >= MAX_FAILED_COMBOS_BEFORE_RETIRE;
  for (const tr of byTreatment.values()) { const n = tr.won + tr.lost; tr.winRate = n > 0 ? tr.won / n : null; }

  const bestTreatments = [...byTreatment.values()]
    .sort((x, y) => (y.winRate ?? -1) - (x.winRate ?? -1) || y.won - x.won)
    .map((t) => t.treatment);
  return { byAngle, byTreatment, bestTreatments };
}

/** The next UNTRIED treatment for a concept, biased toward historically-winning treatments — so a
 *  re-explored angle gets a fresh combination, and we lead with the executions that tend to win. */
export function nextTreatmentFor(angleKey: string, learning: CreativeLearning): Treatment {
  const tried = learning.byAngle.get(angleKey)?.triedTreatments ?? new Set<Treatment>();
  const untried = learning.bestTreatments.filter((t) => !tried.has(t));
  return untried[0] ?? learning.bestTreatments[0] ?? "before_after";
}

/** The full ad configuration that makes a distinct test COMBINATION (CEO): creative treatment × copy
 *  (headline/description/CTA) × destination. The same concept with any element changed is a new combo. */
export interface CombinationElements {
  treatment: Treatment; // creative execution/archetype
  headline: string | null;
  description: string | null;
  cta: string | null;
  destinationUrl: string | null;
}

/** Stable fingerprint of the combination elements — two rows with the same key are the SAME combination. */
export function combinationKey(el: CombinationElements): string {
  return [el.treatment, el.headline, el.description, el.cta, el.destinationUrl]
    .map((x) => (x ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60))
    .join(" | ");
}

/** Record a freshly generated combination as `pending` — the media buyer stamps its outcome later. */
export async function recordCombinationGenerated(
  admin: Admin,
  args: { workspaceId: string; productId: string; angleKey: string; elements: CombinationElements; adCampaignId: string | null; intent: "explore" | "exploit" },
): Promise<void> {
  await admin.from("creative_test_outcomes").insert({
    workspace_id: args.workspaceId,
    product_id: args.productId,
    angle_key: args.angleKey,
    treatment: args.elements.treatment,
    headline: args.elements.headline,
    description: args.elements.description,
    cta: args.elements.cta,
    destination_url: args.elements.destinationUrl,
    combination_key: combinationKey(args.elements),
    ad_campaign_id: args.adCampaignId,
    intent: args.intent,
    outcome: "pending",
  });
}

/**
 * Stamp a combination's OUTCOME (won / lost / reactivated) — called by the media buyer when it crowns /
 * trims / reactivates an adset, closing the learning loop. Resolves the pending `creative_test_outcomes`
 * row by `adCampaignId` (winners carry it) or by `metaAdsetId` → `ad_publish_jobs.campaign_id` (the FK
 * to [[../../tables/ad_campaigns]]; note: `meta_campaign_id` on ad_publish_jobs is the SEPARATE Meta
 * campaign id, not the ad_campaigns UUID). No-op when the ad wasn't system-generated (no ledger row) —
 * the flywheel only learns from our own creatives.
 */
export async function stampCreativeOutcome(
  admin: Admin,
  args: { workspaceId: string; adCampaignId?: string | null; metaAdsetId?: string | null; outcome: "won" | "lost" | "reactivated"; costPerAtcCents?: number | null; cppCents?: number | null; spendCents?: number | null },
): Promise<void> {
  let adCampaignId = args.adCampaignId ?? null;
  if (!adCampaignId && args.metaAdsetId) {
    const { data: pj } = await admin
      .from("ad_publish_jobs")
      .select("campaign_id")
      .eq("meta_adset_id", args.metaAdsetId)
      .not("campaign_id", "is", null)
      .limit(1)
      .maybeSingle();
    adCampaignId = (pj as { campaign_id?: string } | null)?.campaign_id ?? null;
  }
  if (!adCampaignId) return; // not a system-generated combination — nothing to learn from
  await admin
    .from("creative_test_outcomes")
    .update({
      outcome: args.outcome,
      meta_adset_id: args.metaAdsetId ?? undefined,
      cost_per_atc_cents: args.costPerAtcCents ?? undefined,
      cpp_cents: args.cppCents ?? undefined,
      spend_cents: args.spendCents ?? undefined,
      decided_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", args.workspaceId)
    .eq("ad_campaign_id", adCampaignId)
    .eq("outcome", "pending");
}
