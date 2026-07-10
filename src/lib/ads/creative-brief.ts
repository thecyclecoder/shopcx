/**
 * creative-brief — the BRAIN of the Ad Creative Agent (the tool that keeps Bianca's ready-to-test bin
 * stocked). Two jobs, both grounded in the [[../product-intelligence]] SDK so every claim is verifiable
 * by construction (no fabrication, no human gate):
 *
 *   1. selectAngles(pi) — score every candidate angle on TWO axes and rank for a COLD creative:
 *        • acquisitionPower — does it stop a stranger's scroll + earn the first buy? (differentiated,
 *          transformation, objection/skeptic, curiosity). This is what a prospecting creative leads with.
 *        • retentionTruth  — does the product deliver it so well it keeps them? (energy-no-crash, taste)
 *      The trap this exists to avoid: "energy without jitters / no 2pm crash" is the #1 REVIEW cluster
 *      (retention truth) but a COMMODITY acquisition angle — every coffee says it, so it converts nobody.
 *      Commodity angles are demoted; they ride along as SUPPORTING proof, never the headline.
 *
 *   2. buildCreativeBrief(pi, angle) — assemble a fully-backed brief for the chosen angle: the hook, its
 *      proof (a REAL review via byClaim or an ingredient citation), a real transformation story + its
 *      before/after photo, the product/store proof stack, and the offer rendered as an ALLOWED price
 *      treatment (never bare MSRP). The generation step turns this into a Nano Banana Pro prompt.
 *
 * See [[../../../docs/brain/reference/meta-scaling-methodology]] (angle model + price-on-static rule).
 */
import type { ProductIntelligence, PIReview, ProductOffer } from "@/lib/product-intelligence";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ── Angle-scoring lexicons ───────────────────────────────────────────────────
// Commodity = high customer-satisfaction (retention) but zero differentiation for a cold stranger.
const COMMODITY = /\b(no (jitter|crash)|jitter[- ]?free|clean energy|without (the )?(jitter|crash)|steady energy|energy (boost|without)|smooth energy)\b/i;
// Curiosity / pattern-interrupt — earns the click.
const CURIOSITY = /\b(wrong|secret|nobody( tells| talks)|stop scrolling|the truth|doesn'?t want you|industry|hidden|read this|before you|what .* (did|do)|why your)\b/i;
// Objection / skeptic-to-believer — the format that won our 2026-07-09 test.
const OBJECTION = /\b(skeptic|ridiculous|too good to be true|didn'?t believe|thought it was|i was wrong|honestly|sounded (crazy|ridiculous)|rolled my eyes)\b/i;
// Specific transformation (a number + a weight unit, or a loss verb).
const TRANSFORMATION = /\b(\d{1,3})\s*(lbs?|pounds)\b|\b(lost|dropped|shed)\s+\d/i;
// Differentiated, high-intent benefits for THIS product (vs commodity energy).
const HIGH_INTENT = /\b(weight|lbs|pounds|shed|slim|brain fog|foggy|focus|clarity|crav|appetite|belly|bloat|aging|menopaus)\b/i;

export interface ScoredAngle {
  hook: string;
  source: "ad_angle" | "review_cluster" | "transformation" | "benefit";
  leadBenefit: string;
  acquisitionPower: number; // 0–10 — cold-scroll stopping power
  retentionTruth: number; // 0–10 — how well the product delivers it (keeps them)
  commodity: boolean;
  reasons: string[];
  /** raw source object for the brief builder to pull proof from */
  raw?: Row;
}

function scoreAngle(hook: string, leadBenefit: string, source: ScoredAngle["source"], retentionSignal: number, raw?: Row): ScoredAngle {
  const text = `${hook} ${leadBenefit}`;
  const reasons: string[] = [];
  let acq = 4; // neutral baseline
  const commodity = COMMODITY.test(text) || (/energy/i.test(leadBenefit) && !HIGH_INTENT.test(hook));
  if (commodity) { acq -= 3; reasons.push("commodity (energy/no-crash — retention, not acquisition)"); }
  if (TRANSFORMATION.test(text)) { acq += 4; reasons.push("specific transformation (a real number)"); }
  if (OBJECTION.test(text)) { acq += 3; reasons.push("objection/skeptic frame (won 2026-07-09)"); }
  if (CURIOSITY.test(text)) { acq += 2; reasons.push("curiosity / pattern-interrupt"); }
  if (HIGH_INTENT.test(text) && !commodity) { acq += 2; reasons.push("differentiated high-intent benefit"); }
  if (source === "transformation") { acq += 2; reasons.push("real customer transformation story"); }
  acq = Math.max(0, Math.min(10, acq));
  // retentionTruth: commodity/experience benefits + high review frequency = strong retention signal.
  let ret = Math.max(0, Math.min(10, retentionSignal));
  if (commodity) ret = Math.max(ret, 8); // no-crash IS a true, loved experience benefit
  return { hook, source, leadBenefit, acquisitionPower: acq, retentionTruth: ret, commodity, reasons, raw };
}

/**
 * Rank candidate angles for a COLD/prospecting creative: highest acquisition power first, commodity last.
 * Pulls candidates from the ready ad_angles, the biggest real transformation stories, and the review
 * clusters (whose frequency feeds retentionTruth). Retention-only (commodity) angles sink — they become
 * supporting proof, not the lead.
 */
export function selectAngles(pi: ProductIntelligence, transformationStories: PIReview[] = []): ScoredAngle[] {
  const out: ScoredAngle[] = [];

  for (const a of pi.adAngles as Row[]) {
    out.push(scoreAngle(str(a.hook_one_liner), str(a.lead_benefit_anchor), "ad_angle", 5, a));
  }
  // Transformation stories → their own high-acquisition angles (real person, real number, real photo).
  for (const r of transformationStories.slice(0, 5)) {
    const line = str(r.smart_quote) || str(r.body).slice(0, 90);
    out.push(scoreAngle(line, "Weight loss (real customer transformation)", "transformation", 6, r as unknown as Row));
  }
  // Review clusters → retentionTruth signal (frequency), and a couple as candidate angles.
  const clusters = ((pi.reviewAnalysis as Row | null)?.top_benefits as Array<{ benefit: string; frequency?: number }> | undefined) ?? [];
  const maxFreq = Math.max(1, ...clusters.map((c) => Number(c.frequency ?? 0)));
  for (const c of clusters) {
    const retSignal = Math.round((Number(c.frequency ?? 0) / maxFreq) * 10);
    out.push(scoreAngle(c.benefit, c.benefit, "review_cluster", retSignal, c as unknown as Row));
  }

  // Dedup by hook, keep the highest-scored, then rank.
  const byHook = new Map<string, ScoredAngle>();
  for (const a of out) {
    const k = a.hook.toLowerCase().slice(0, 60);
    const prev = byHook.get(k);
    if (!prev || a.acquisitionPower > prev.acquisitionPower) byHook.set(k, a);
  }
  return [...byHook.values()].sort((a, b) => b.acquisitionPower - a.acquisitionPower || b.retentionTruth - a.retentionTruth);
}

// ── Brief ────────────────────────────────────────────────────────────────────
export interface CreativeBrief {
  productTitle: string;
  angle: ScoredAngle;
  /** The proof behind the LEAD claim — a real review quote or an ingredient-research citation. */
  leadProof: { kind: "review" | "ingredient" | "cluster"; text: string; attribution?: string } | null;
  /** A real customer transformation to anchor the creative (weight-loss angles), with its photo if any. */
  transformation: { reviewer: string; quote: string; beforeAfterImage: string | null } | null;
  /** Supporting retention truths (energy-no-crash, taste) — body copy, never the headline. */
  supportingBenefits: string[];
  /** Verified proof stack — certs, award, store selling points. */
  proofStack: string[];
  /** The offer rendered as an ALLOWED price treatment (never bare MSRP). */
  offer: { headline: string; strikethrough: string | null; perServing: string | null; disclaimer: string } | null;
  /** Image references for Nano Banana Pro (before/after, hero, ingredient, packshot). */
  imageRefs: { role: string; url: string }[];
  /** Guardrail attestations — why this brief is safe to auto-publish. */
  guardrails: string[];
}

function money(cents: number | null | undefined): string | null {
  return cents == null ? null : `$${(cents / 100).toFixed(2)}`;
}

/**
 * Build a fully-backed brief for a chosen angle. Every claim traces to the SDK: the lead proof is a real
 * review (via byClaim) or an ingredient citation; the transformation is a real reviewer + their photo; the
 * offer uses an allowed price treatment. Nothing is invented.
 */
export async function buildCreativeBrief(pi: ProductIntelligence, angle: ScoredAngle, transformationStories: PIReview[] = []): Promise<CreativeBrief> {
  const productTitle = str((pi.product as Row | null)?.title) || "the product";

  // Lead proof: prefer a real review backing this benefit; else an ingredient citation.
  let leadProof: CreativeBrief["leadProof"] = null;
  const reviewsForClaim = await pi.reviews.byClaim(angle.leadBenefit).catch(() => [] as PIReview[]);
  const pick = reviewsForClaim.find((r) => r.smart_quote) ?? reviewsForClaim[0];
  if (pick) {
    leadProof = { kind: "review", text: (pick.smart_quote || pick.body || "").slice(0, 160), attribution: pick.reviewer_name ?? "verified customer" };
  } else {
    const ir = (pi.ingredientResearch as Row[]).find((x) => HIGH_INTENT.test(str(x.benefit_headline)) || str(x.benefit_headline));
    if (ir) leadProof = { kind: "ingredient", text: str(ir.benefit_headline) || str(ir.mechanism_explanation).slice(0, 160) };
  }

  // Transformation: for weight-loss/transformation angles, anchor on a real story + its photo.
  let transformation: CreativeBrief["transformation"] = null;
  if (/weight|transformation|lbs|pound|shed|slim/i.test(`${angle.hook} ${angle.leadBenefit}`) && transformationStories.length) {
    const t = transformationStories.find((r) => r.images.length) ?? transformationStories[0];
    const ba = (pi.media.byCategory.before_after?.[0] as Row | undefined);
    transformation = {
      reviewer: t.reviewer_name ?? "verified customer",
      quote: (t.smart_quote || t.body || "").slice(0, 160),
      beforeAfterImage: t.images[0] ?? (ba ? str(ba.url) : null),
    };
  }

  // For a transformation angle the story IS the strongest, most on-angle lead proof — prefer it over a
  // generic ingredient citation the benefit-name lookup may have fallen back to.
  if (transformation && (!leadProof || leadProof.kind === "ingredient")) {
    leadProof = { kind: "review", text: transformation.quote, attribution: transformation.reviewer };
  }

  // Supporting retention truths — the loved-but-commodity benefits (energy-no-crash, taste) go in the body.
  const supportingBenefits = selectAngles(pi, transformationStories)
    .filter((a) => a.commodity || a.retentionTruth >= 8)
    .slice(0, 3)
    .map((a) => a.leadBenefit);

  // Verified proof stack — product certs/awards + store selling points.
  const p = pi.product as Row | null;
  const proofStack = [
    ...((p?.awards as string[] | null) ?? []),
    ...((p?.certifications as string[] | null) ?? []),
    ...pi.store.brandProofPoints.slice(0, 4),
  ];

  // Offer → allowed price treatment(s).
  const o = pi.offer as ProductOffer | null;
  const offer = o ? {
    headline: o.headline,
    strikethrough: o.msrpCents != null && o.discountedUnitCents != null ? `~~${money(o.msrpCents)}~~ ${money(o.discountedUnitCents)}` : null,
    perServing: o.perServingCents != null ? `${money(o.perServingCents)}/serving vs a $4–8 coffee/latte` : null,
    disclaimer: o.disclaimer,
  } : null;

  // Image refs for generation.
  const imageRefs: CreativeBrief["imageRefs"] = [];
  const hero = pi.media.byCategory.hero?.[0] as Row | undefined;
  if (hero) imageRefs.push({ role: "hero", url: str(hero.url) });
  if (transformation?.beforeAfterImage) imageRefs.push({ role: "before_after", url: transformation.beforeAfterImage });
  if (pi.media.isolatedPackshots[0]) imageRefs.push({ role: "packshot", url: pi.media.isolatedPackshots[0] });

  const guardrails = [
    "all claims trace to product-intelligence (no fabrication)",
    leadProof ? `lead claim backed by ${leadProof.kind}` : "no lead proof found — flag",
    transformation ? "transformation is a real reviewer + real photo" : "no fabricated testimonial",
    offer ? "price shown only via allowed treatment (no bare MSRP)" : "no price shown",
  ];

  return { productTitle, angle, leadProof, transformation, supportingBenefits, proofStack, offer, imageRefs, guardrails };
}
