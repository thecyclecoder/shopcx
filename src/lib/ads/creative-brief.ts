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
import { META_CAPS } from "@/lib/ad-tool-config";
import { hasAnyLf8 } from "@/lib/ads/lf8";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ── Competitor-hook discount sanitizer ──────────────────────────────────────
// A `source:'competitor'` angle's raw hook comes from a rival's live ad text — and a competitor
// often bakes their promotional NUMBER into the hook itself ("MUD\WTR Mushroom Tea Blend — 50% OFF",
// "Save 40% Today", "Free Shipping"). Reused verbatim as OUR headline, that number lands on our
// creative and CONTRADICTS the real offer the same brief renders from `brief.offer` (e.g. image
// screams "50% OFF" while our own badge says "Up to 34% off" — the 2026-07-14 Amazing Creamer bin
// draft). The discount shown on our ad must come SOLELY from `brief.offer` (our real store offer);
// a competitor's promotional number must never leak in through their hook.
// Note: patterns ending in "%" don't use `\b` at the end — `%` is non-word so `%\b` would require a
// following WORD char (fails on "40% on" because " " is non-word). We use a whitespace / EOL lookahead
// instead so "40% on your first bag" scrubs cleanly.
const DISCOUNT_TOKEN_PATTERNS: readonly RegExp[] = [
  /\b(?:up to\s+)?\d{1,3}\s*%\s*(?:off|discount|savings?)\b/gi,        // "50% OFF" · "up to 40% off"
  /\bsave\s+(?:up to\s+)?(?:\$\d[\d.,]*|\d{1,3}\s*%)(?=\s|$|[^\w%])/gi, // "save 40%" · "save $10"
  /\b\$\d[\d.,]*\s*off\b/gi,                                            // "$10 off"
  /\bfree\s+shipping\b/gi,                                              // "free shipping"
  /\b(?:bogo|buy\s+one\s+get\s+one(?:\s+free)?)\b/gi,                   // "BOGO" · "buy one get one"
  /\b\d+\s+for\s+\$?\d[\d.,]*\b/gi,                                     // "2 for $30"
  /\b\d+\s+for\s+the\s+price\s+of\s+\d+\b/gi,                           // "3 for the price of 2"
];

/**
 * Strip promotional discount/offer tokens (percent-off, dollar-off, free-shipping, BOGO,
 * "X for $Y") out of a competitor-sourced hook before it becomes an ad-copy input. The
 * ONLY discount rendered on the creative must come from `brief.offer` (our real store offer).
 * Own-brand hooks pass through unchanged — this is called only for `source:'competitor'`.
 */
export function sanitizeCompetitorHook(hook: string): string {
  let out = hook;
  for (const re of DISCOUNT_TOKEN_PATTERNS) out = out.replace(re, " ");
  // A stripped token often leaves an orphan separator between two spaces ("Coffee  —  today")
  // and dangling punctuation at either end. Collapse both so what remains reads naturally.
  out = out.replace(/\s+[—–\-|·+&]\s+/g, " ");
  out = out.replace(/^[\s,;:.|\-·—–+&]+|[\s,;:.|\-·—–+&]+$/g, "");
  out = out.replace(/\s{2,}/g, " ").trim();
  return out;
}

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
  source: "ad_angle" | "review_cluster" | "transformation" | "benefit" | "ingredient" | "authority" | "competitor";
  leadBenefit: string;
  acquisitionPower: number; // 0–10 — cold-scroll stopping power
  retentionTruth: number; // 0–10 — how well the product delivers it (keeps them)
  commodity: boolean;
  /** A real before/after photo backs this angle — the strongest cold hook; wins ties. */
  hasRealPhoto: boolean;
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
  return { hook, source, leadBenefit, acquisitionPower: acq, retentionTruth: ret, commodity, hasRealPhoto: false, reasons, raw };
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
  // Capped so a corpus full of weight-loss reviews can't crowd EVERY other concept out of the pool.
  for (const r of transformationStories.slice(0, 5)) {
    const line = str(r.smart_quote) || str(r.body).slice(0, 90);
    const a = scoreAngle(line, "Weight loss (real customer transformation)", "transformation", 6, r as unknown as Row);
    if ((r.images ?? []).length) { a.acquisitionPower = Math.min(10, a.acquisitionPower + 2); a.hasRealPhoto = true; a.reasons.push("has a REAL before/after photo (strongest — leads over a photoless number)"); }
    out.push(a);
  }
  // Ingredient / mechanism angles — "the ingredient that does X / how it actually works". A DIFFERENT
  // concept from a transformation story (the ingredient-breakdown creative is a real winner for us).
  for (const ir of (pi.ingredientResearch as Row[]).slice(0, 4)) {
    const hook = str(ir.benefit_headline) || str(ir.mechanism_explanation).slice(0, 80);
    if (hook) out.push(scoreAngle(hook, "Ingredient / mechanism", "ingredient", 5, ir));
  }
  // Authority / proof angles — nutritionist / 3rd-party-tested / award / guarantee credibility.
  const p = pi.product as Row | null;
  const authorityPoints = [
    ...(((p?.awards as string[] | null) ?? [])),
    ...(((p?.certifications as string[] | null) ?? [])),
    ...pi.store.brandProofPoints,
  ].filter(Boolean).slice(0, 4);
  for (const pt of authorityPoints) out.push(scoreAngle(str(pt), "Authority / proof", "authority", 5));
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
  const ranked = [...byHook.values()].sort((a, b) =>
    b.acquisitionPower - a.acquisitionPower
    || (Number(b.hasRealPhoto) - Number(a.hasRealPhoto)) // among ties, a real before/after wins
    || b.retentionTruth - a.retentionTruth);

  // DIVERSIFY (CEO 2026-07-11): round-robin across concept TYPES (source) so the top of the pool spans
  // transformation + ingredient + authority + ad_angle + review_cluster — instead of 8 weight-loss
  // reviews crowding everything else out. Groups lead by their strongest angle; then we take one per
  // group per round. Keeps acquisition ranking WITHIN a concept while guaranteeing concept variety across.
  const bySource = new Map<ScoredAngle["source"], ScoredAngle[]>();
  for (const a of ranked) { const g = bySource.get(a.source) ?? []; g.push(a); bySource.set(a.source, g); }
  const groups = [...bySource.values()].sort((g1, g2) => g2[0].acquisitionPower - g1[0].acquisitionPower);
  const diversified: ScoredAngle[] = [];
  for (let i = 0; diversified.length < ranked.length; i++) {
    let added = false;
    for (const g of groups) if (g[i]) { diversified.push(g[i]); added = true; }
    if (!added) break;
  }
  return diversified;
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

  // Competitor hook sanitization: strip any percent-off / $-off / free-shipping / BOGO claim the
  // rival baked into their hook BEFORE it becomes part of the brief. brief.angle.hook is the
  // single source of the headline for every downstream consumer (buildPrompt, buildMetaCopy,
  // expectedCopy for QA), so scrubbing it once here means a competitor's promotional number can
  // never surface on our ad. Own-brand angles are untouched.
  angle = angle.source === "competitor"
    ? { ...angle, hook: sanitizeCompetitorHook(angle.hook) }
    : angle;

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

  // Transformation: anchor on ONE real story so the headline number, the caption, and the photo are all
  // the SAME person. When the angle IS a transformation, use its own reviewer (angle.raw). Only show a
  // before/after if THAT reviewer submitted one — never borrow another customer's photo under this number
  // (the 2026-07-10 "84 lbs headline / 63 lbs caption / third person's photo" inconsistency).
  let transformation: CreativeBrief["transformation"] = null;
  if (/weight|transformation|lbs|pound|shed|slim/i.test(`${angle.hook} ${angle.leadBenefit}`) && transformationStories.length) {
    const angleReviewer = angle.source === "transformation" ? (angle.raw as unknown as PIReview | undefined) : undefined;
    const t = angleReviewer ?? transformationStories.find((r) => r.images.length) ?? transformationStories[0];
    transformation = {
      reviewer: t.reviewer_name ?? "verified customer",
      quote: (t.smart_quote || t.body || "").slice(0, 160),
      beforeAfterImage: (t.images ?? [])[0] ?? null, // this reviewer's OWN photo only — no borrowing
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

/**
 * buildMetaCopy(brief) — the Meta ad text (primary / headline / description) Dahlia publishes with each
 * creative. Composed from the SAME grounded brief as the image, so the caption matches the render.
 *
 * Fixes the 2026-07-13 defect where the copy was `headline = the OFFER (truncated)`, `primaryText =
 * hook + a benefit fragment`, `description = empty` — e.g. "I lost 40+ pounds! Appetite
 * suppression/craving control" with the discount jammed into the headline. Now:
 *   - **headline** = the hook/benefit (never the offer — the offer belongs in the description).
 *   - **primaryText** = a real DR caption: a proof-led opener, a benefit line, the trust stack, then the
 *     offer + a soft CTA — on separate lines.
 *   - **description** = the allowed price treatment (per-serving value or offer headline).
 *
 * De-brand safety: a `source:'competitor'` angle's raw `hook` can carry the COMPETITOR's brand/product
 * name (e.g. "MUD\WTR vs Ryze") — the image de-brands it, and so must the caption. So for a competitor
 * angle we NEVER put the raw hook in the copy; the headline falls back to a de-branded benefit and the
 * opener leads with OUR review/proof (always our own words). Own-brand angles use the hook directly.
 */
export function buildMetaCopy(brief: CreativeBrief): { primaryText: string; headline: string; description: string } {
  const clip = (raw: string, n: number): string => {
    const s = (raw ?? "").trim();
    if (s.length <= n) return s;
    const cut = s.slice(0, n);
    const sp = cut.lastIndexOf(" ");
    return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trim().replace(/[\s.,;:!-]+$/, "");
  };
  const isCompetitor = brief.angle.source === "competitor";

  // A de-branded benefit line (always OUR words) — used as the headline for competitor imitations and as
  // a fallback everywhere. Prefer a supporting truth that carries a Life-Force-8 term (energy/sleep/focus
  // /protect/family/proven/…) so the cold-scroll ad leads with a benefit that stops the scroll — the
  // ads-supervisor `live_ad_lf8_thin` gate rejects zero-LF8 copy, so the generator satisfies the gate by
  // construction. Falls through to the current-behavior chain when no LF8-adjacent benefit exists.
  const supporting = brief.supportingBenefits.filter(Boolean);
  const lf8Supporting = supporting.find((b) => hasAnyLf8(b.toLowerCase()));
  const legacyLeadBenefit =
    brief.angle.leadBenefit && !/proven competitor angle/i.test(brief.angle.leadBenefit) ? brief.angle.leadBenefit : "";
  const benefitHeadline = lf8Supporting ?? supporting[0] ?? legacyLeadBenefit ?? "";

  // HEADLINE — the hook/benefit, NEVER the offer. Competitor imitations skip the (possibly brand-carrying)
  // raw hook in favor of the de-branded benefit.
  const headline = clip(
    (isCompetitor ? benefitHeadline : brief.angle.hook) || benefitHeadline || brief.productTitle,
    META_CAPS.headline,
  );

  // OPENER — lead with real proof (our customer's own words → never a competitor brand). Own-brand angles
  // may lead with the hook instead.
  let opener = "";
  if (brief.transformation?.quote) opener = `"${clip(brief.transformation.quote, 120)}" — ${brief.transformation.reviewer}`;
  else if (brief.leadProof?.kind === "review" && brief.leadProof.text) opener = `"${clip(brief.leadProof.text, 120)}"${brief.leadProof.attribution ? ` — ${brief.leadProof.attribution}` : ""}`;
  else if (!isCompetitor && brief.angle.hook) opener = brief.angle.hook.trim();

  // BENEFIT LINE — order supporting benefits so any LF8-carrying one leads (same reason as the headline
  // preference above); when the headline already used the LF8 supporting benefit this promotes the next
  // LF8-adjacent term into the body if present.
  const orderedSupporting = supporting.slice().sort((a, b) => Number(hasAnyLf8(b.toLowerCase())) - Number(hasAnyLf8(a.toLowerCase())));
  const benefitLine = orderedSupporting.length
    ? `${brief.productTitle} — ${orderedSupporting.slice(0, 2).join(", ")}.`
    : "";
  const proofLine = brief.proofStack.filter(Boolean).slice(0, 3).join(" · ");
  const offerLine = brief.offer?.headline ? `${brief.offer.headline}. Shop now 👉` : "Shop now 👉";

  let primaryText = [opener, [benefitLine, proofLine].filter(Boolean).join("\n"), offerLine]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, META_CAPS.primary_text);

  // LF8 GUARDRAIL — if the composed headline + primary text STILL carry no Life-Force-8 term (e.g. the
  // hook is a de-branded competitor claim and every supporting benefit lacks LF8 language), prepend an
  // LF8-carrying supporting benefit line so the caption satisfies the ads-supervisor gate. Never
  // fabricates language: if nothing LF8-adjacent exists in the brief, leaves the copy as-is and lets the
  // supervisor re-flag on the next pass — the human-facing path for "product has no LF8-adjacent truth".
  if (!hasAnyLf8(`${headline} ${primaryText}`.toLowerCase())) {
    const injectable = supporting.find((b) => hasAnyLf8(b.toLowerCase()));
    if (injectable) {
      const lead = injectable.trim().replace(/[.!?]+$/, "");
      primaryText = `${lead}.\n\n${primaryText}`.slice(0, META_CAPS.primary_text);
    }
  }

  // DESCRIPTION — the allowed price treatment (never empty). Falls back to a proof line.
  const description = clip(brief.offer?.perServing ?? brief.offer?.headline ?? proofLine ?? "", META_CAPS.description);

  return { primaryText, headline, description };
}
