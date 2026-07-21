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
import { chooseGroundedSubstitute, isCompetitorOffer, stripCompetitorOffer } from "@/lib/ads/debrand";
import { competitorFocalIsWarmHot, type CreativeIntent } from "@/lib/ads/creative-sourcing";
import type { ConceptTags } from "@/lib/creative-skeleton";

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
  /** dahlia-researches-from-winners-flow-ad-library Phase 1 — the unified breakdown OUR vision
   *  emits on every winners-flow ingest ([[../creative-skeleton|ConceptTags]]: angle, archetype,
   *  why_it_works, cialdini_lever, awareness_stage, format). Threaded onto competitor-source
   *  angles by `stockProduct` so `buildCreativeBrief` can surface it on the brief AND Dahlia's
   *  research reads the imitation rubric alongside the four proven copy slots. Own-brand angles
   *  leave this null. */
  conceptTags?: ConceptTags | null;
}

/** Internal angle-CATEGORY labels used as an angle's `leadBenefit` for grouping (never real ad copy).
 *  They must never render on a creative — `supportingBenefits` maps angle leadBenefits into the
 *  on-image subhead, so a category label like "Ingredient / mechanism" leaked into the pixels and
 *  Max's QC rejected it (2026-07-19/20). Defense-in-depth alongside the ingredient-angle source fix:
 *  filter these out wherever leadBenefit becomes rendered copy. */
export const INTERNAL_ANGLE_LABELS: ReadonlySet<string> = new Set([
  "Ingredient / mechanism",
  "Weight loss (real customer transformation)",
]);

/** True iff a string is an internal angle-category label that must never render as ad copy. */
export function isInternalAngleLabel(s: string | null | undefined): boolean {
  return !!s && INTERNAL_ANGLE_LABELS.has(s.trim());
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

  // Curated LEAD BENEFIT — the product's differentiated acquisition angle from
  // `product_benefit_selections` role='lead' (per-product curation). Seeded here as a top-priority
  // candidate so the strongest differentiated hook is on the table BEFORE ranking / diversification /
  // imitation — the root fix for dahlia-hooks-riff-competitor-angle-and-weave-in-lead-benefit Phase 1
  // (2026-07-18). Without this seed, hooks only ever come from generic ingredient headlines, review
  // clusters, ad_angles rows, and competitor angles — the curated lead benefit (e.g. Amazing Coffee's
  // WEIGHT LOSS) never even becomes a candidate, so Dahlia's cold creative can lead with a borrowed
  // commodity hook ("no jitters") with our real differentiator nowhere on the ad. `buildCreativeBrief`
  // then attaches a real leadProof via `pi.reviews.byClaim(benefit_name)`. Degrades gracefully to
  // today's behavior when no role='lead' row exists.
  const leadBenefitRow = (pi.benefits as Row[]).find((b) => str(b.role) === "lead");
  if (leadBenefitRow) {
    const name = str(leadBenefitRow.benefit_name).trim();
    const phrases = Array.isArray(leadBenefitRow.customer_phrases)
      ? (leadBenefitRow.customer_phrases as unknown[]).map(str).filter(Boolean)
      : [];
    const punchyPhrase = phrases.find((p) => p.length > 0 && p.length <= 60) ?? phrases[0] ?? "";
    const hook = punchyPhrase || name;
    if (name) {
      const scored = scoreAngle(hook, name, "benefit", 7, leadBenefitRow);
      // Curated lead benefit is a DIFFERENTIATED acquisition angle by construction — override
      // acquisitionPower to top-of-pool and force `commodity=false` so the diversification pass ranks
      // its source group first and `buildCreativeBrief`'s supporting-benefits filter (commodity ||
      // retentionTruth>=8) doesn't demote it to body copy.
      scored.acquisitionPower = 10;
      scored.commodity = false;
      scored.reasons.unshift(
        "curated lead benefit (product_benefit_selections role='lead' — the differentiated acquisition angle)",
      );
      out.push(scored);
    }
  }

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
  // leadBenefit MUST be a REAL benefit string, never the internal category label: it feeds
  // `supportingBenefits` (the rendered subhead), so the literal "Ingredient / mechanism" leaked onto
  // the on-image copy and Max's QC rejected it (2026-07-19/20). Use the ingredient's real
  // mechanism/benefit as the supporting truth instead.
  for (const ir of (pi.ingredientResearch as Row[]).slice(0, 4)) {
    const hook = str(ir.benefit_headline) || str(ir.mechanism_explanation).slice(0, 80);
    const leadBen = str(ir.mechanism_explanation).slice(0, 100) || str(ir.benefit_headline) || hook;
    if (hook) out.push(scoreAngle(hook, leadBen, "ingredient", 5, ir));
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

/** cold-prospecting-never-imitates-a-warm-hot-offer-or-retargeting-competitor-ad Phase 2 —
 *  HARD-EXCLUDE competitor angles whose focal point reads warm/hot (offer/discount/bundle/
 *  bonus/scarcity/social-proof/retargeting per [[creative-sourcing]] `competitorFocalIsWarmHot`)
 *  when the target audience temperature is COLD, then fall back to the caller's own-brand
 *  angles when the filtered competitor pool empties — so a cold prospecting test can NEVER
 *  lead with a competitor's offer/bundle/cross-category ad. Warm/hot temperatures keep the raw
 *  competitor pool (the exclusion is temperature-scoped by design — a warm/hot test WANTS the
 *  offer/mechanism/review angles as its imitation base).
 *
 *  The fallback is the CALLER'S own-brand pool at its natural rank — own-brand angles are
 *  cold-appropriate by construction because `selectAngles`'s scoring favors transformation /
 *  objection / curiosity hooks (the CEO's `results_first` / `benefit-led` / `problem→solution`
 *  families). If the caller passes ONLY warm/hot competitor angles, the returned pool is JUST
 *  the own-brand angles — never a warm/hot competitor ad as the "least-bad" pick.
 *
 *  Pure. Both inputs are treated as readonly; the returned array is a fresh concat so callers
 *  can mutate it (stockProduct filters by learning ledger after this call). */
export function selectAnglesForTemperature(
  competitorAngles: readonly ScoredAngle[],
  ownBrandAngles: readonly ScoredAngle[],
  temperature: CreativeIntent["audience_temperature"],
): ScoredAngle[] {
  if (temperature !== "cold") {
    return [...competitorAngles, ...ownBrandAngles];
  }
  const coldCompetitorPool = competitorAngles.filter((a) => {
    const raw = (a.raw ?? {}) as { offer?: unknown };
    const offer = typeof raw.offer === "string" ? raw.offer : null;
    return !competitorFocalIsWarmHot({ offer, conceptTags: a.conceptTags ?? null });
  });
  return [...coldCompetitorPool, ...ownBrandAngles];
}

// ── Brief ────────────────────────────────────────────────────────────────────
export interface CreativeBrief {
  productTitle: string;
  angle: ScoredAngle;
  /** Owner's free-text directions for THIS generation (Research › Ads "Generate ad like this"),
   *  e.g. "remove the free tote badge". Applied as an explicit instruction in BOTH the image prompt
   *  and the copy-author prompt so it lands first-pass. Null/absent when no note was given. */
  authorNotes?: string | null;
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
  /**
   * Preserved competitor copy DNA — the four proven slots the driving competitor's ad has kept
   * live across 45+ paid days (per creative_skeletons: hook / framework / mechanism_claim /
   * proof / offer), plus the competitor's advertiser token needed for debranding. Populated ONLY
   * when the driving `angle.source === 'competitor'`; own-brand angles carry null.
   *
   * Consumed by Dahlia's author-mode box session (stockProduct's author-mode branch, wired in
   * Phase 2) — she debrands each slot via `debrandForOurBrand` and treats the result as
   * authoring material so the imitate-then-innovate flow reuses the market-tested WORDS the
   * competitor's picture already proved, with only the brand stripped. Also read by the M2
   * never-fabricate firewall's `verifyClaimTrace` when a claim cites `source='competitorDna'`
   * — a slot value here is the required evidence. Deterministic buildMetaCopy is untouched
   * (the field is opt-in for author-mode consumers only).
   */
  competitorDna?: {
    hook: string;
    framework: string | null;
    mechanismClaim: string | null;
    proof: string | null;
    offer: string | null;
    competitorAdvertiser: string | null;
  };
  /**
   * dahlia-researches-from-winners-flow-ad-library Phase 1 — the WINNER-CONCEPT unified
   * breakdown OUR vision emits for the underlying competitor ad ([[../creative-skeleton|ConceptTags]]:
   * angle, archetype, why_it_works, cialdini_lever, awareness_stage, format). Populated ONLY
   * when `angle.source === 'competitor'` AND the ScoredAngle was threaded with the winners-flow
   * concept tags (`stockProduct` populates it from `getProvenCompetitorAngles`). Own-brand
   * angles leave this null. Consumed by:
   *   • Dahlia's copy-author session as the imitation rubric alongside `competitorDna` — she
   *     writes AGAINST the archetype + why_it_works + cialdini_lever the winner already proved;
   *   • Max's Phase 2 QA grader as the benchmark for competitor-selection + temperature-fit
   *     grading (a cold-audience task's winner-concept awareness_stage should be
   *     unaware/problem_aware — a mismatch scores lower on the competitor-selection axis).
   */
  conceptTags?: ConceptTags | null;
  /**
   * dahlia-hooks-riff-competitor-angle-and-weave-in-lead-benefit Phase 2 — the product's
   * curated LEAD BENEFIT (`product_benefit_selections` role='lead') threaded onto a
   * source='competitor' brief so the authored hook must BLEND the competitor's proven
   * framework/mechanism (from `competitorDna`) with our differentiated lead benefit — a RIFF,
   * not a pure borrow. Populated only when `angle.source === 'competitor'` AND the brief is
   * NOT built for the minority PURE-COMPETITOR explore slot (`opts.pureCompetitor`).
   * Own-brand angles and the pure-competitor slot leave this null. The `softPhrasings`
   * comes verbatim from the benefit row's `customer_phrases`, so Dahlia can pick a naturally-
   * spoken phrase ('feel lighter' / 'curbs my appetite') without inventing one — the
   * never-fabricate firewall keeps the vocabulary honest. Consumed by:
   *   • Dahlia's copy-author SKILL IMITATE-DEBRANDED rule — the RIFF rail requires this
   *     benefit to be present in the hook alongside the debranded competitor framework;
   *   • Max's independent copy QC — 'lead-benefit-woven-in' is scored against this field.
   */
  leadBenefitWeave?: {
    benefitName: string;
    softPhrasings: string[];
  } | null;
  /**
   * swap-competitor-offer-slot-for-our-grounded-proof-benefit-or-feature-in-debrand Phase 1 —
   * derived product features (ingredient count, format) surfaced as the LAST-RESORT substitute
   * pool for `chooseGroundedSubstitute` when the competitor's offer slot needs swapping and the
   * brief carries no proofStack proof point / supporting benefit / lead proof. Populated from
   * `pi.ingredients.length` (e.g. `"15 superfoods per tab"`); rarely fires since proofStack is
   * usually rich, but keeps the substitute chooser closed under empty briefs. Optional; the
   * substitute chooser handles a missing / empty array as "no feature available."
   */
  productFeatures?: string[];
}

/**
 * dahlia-hooks-riff-competitor-angle-and-weave-in-lead-benefit Phase 2 — build-time options for
 * `buildCreativeBrief`. `pureCompetitor` is the escape hatch stockProduct uses for the MINORITY
 * explore slot per batch (at most one) so we still ship a pure competitor imitation for learning;
 * every other competitor-source brief gets the RIFF (lead benefit blended in) by default.
 */
export interface BuildCreativeBriefOpts {
  /** When true AND the driving angle is `source:'competitor'`, DO NOT thread the product's
   *  role='lead' benefit onto the brief. The riff is the STRONG DEFAULT (`false`); the
   *  minority pure-competitor slot is opt-in for learning. Ignored for own-brand angles. */
  pureCompetitor?: boolean;
  /** Research › Ads "Generate ad like this" free-text notes — the owner's targeted directions for
   *  THIS generation ("remove the free tote badge", "lead with the focus benefit"). Surfaced onto
   *  `brief.authorNotes` so both the image prompt (`buildPrompt`) and the copy-author prompt
   *  (`buildCopyAuthorPrompt`) apply it first-pass — skipping rounds of manual editing. */
  authorNotes?: string;
}

function money(cents: number | null | undefined): string | null {
  return cents == null ? null : `$${(cents / 100).toFixed(2)}`;
}

/**
 * Build a fully-backed brief for a chosen angle. Every claim traces to the SDK: the lead proof is a real
 * review (via byClaim) or an ingredient citation; the transformation is a real reviewer + their photo; the
 * offer uses an allowed price treatment. Nothing is invented.
 */
export async function buildCreativeBrief(
  pi: ProductIntelligence,
  angle: ScoredAngle,
  transformationStories: PIReview[] = [],
  opts: BuildCreativeBriefOpts = {},
): Promise<CreativeBrief> {
  const productTitle = str((pi.product as Row | null)?.title) || "the product";

  // Competitor hook sanitization: strip any percent-off / $-off / free-shipping / BOGO claim the
  // rival baked into their hook BEFORE it becomes part of the brief. brief.angle.hook is the
  // single source of the headline for every downstream consumer (buildPrompt, buildMetaCopy,
  // expectedCopy for QA), so scrubbing it once here means a competitor's promotional number can
  // never surface on our ad. Own-brand angles are untouched.
  angle = angle.source === "competitor"
    ? { ...angle, hook: sanitizeCompetitorHook(angle.hook) }
    : angle;

  // Lead proof: prefer a FEATURED review (curated for marketing), favoring one that also backs this
  // benefit; then any claim-relevant review; else an ingredient citation. Using a featured review is
  // what lets an imitated competitor testimonial be SWAPPED for one of OUR real featured reviews
  // (2026-07-17 — a competitor's review was rendering on our ad instead of ours). `byClaim` reviews
  // carry the `featured` flag, so a claim-relevant featured review wins; `pi.reviews.featured` is the
  // fallback pool when no claim-relevant featured review exists.
  let leadProof: CreativeBrief["leadProof"] = null;
  const reviewsForClaim = await pi.reviews.byClaim(angle.leadBenefit).catch(() => [] as PIReview[]);
  const featuredPool = pi.reviews.featured ?? [];
  const pick =
    reviewsForClaim.find((r) => r.featured && r.smart_quote) ?? // featured + claim-relevant + punchy quote
    reviewsForClaim.find((r) => r.featured) ??                  // featured + claim-relevant
    featuredPool.find((r) => r.smart_quote) ??                  // any featured with a quote
    featuredPool[0] ??                                          // any featured
    reviewsForClaim.find((r) => r.smart_quote) ??              // claim-relevant (non-featured) with a quote
    reviewsForClaim[0];                                         // any claim-relevant
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
  const supportingBenefitsBase = selectAngles(pi, transformationStories)
    .filter((a) => a.commodity || a.retentionTruth >= 8)
    .map((a) => a.leadBenefit)
    // never let an internal angle-category label reach the rendered subhead (defense-in-depth)
    .filter((b) => b && !isInternalAngleLabel(b))
    .slice(0, 3);
  // dahlia-converts-competitor-benefits-to-ours — surface OUR product's REAL listed benefits
  // (`product_benefit_selections` role in {lead, supporting}) so when Dahlia imitates a competitor she
  // can CONVERT their benefit claims into OURS instead of carrying a benefit our product lacks (the
  // Bloom "gut / immunity / hair / nails" → Amazing Creamer "skin / focus / weight" case — Dahlia kept
  // carrying Bloom's benefits and the never-fabricate firewall correctly rejected them). These are ALSO
  // firewall-groundable: `verifyClaimTrace` grounds a `supportingBenefit` claim against
  // `brief.supportingBenefits`, so a claim about one of OUR listed benefits now passes the gate.
  // Appended AFTER the retention-truth benefits so the image subhead (`.slice(0,2)`) is unchanged.
  const ourListedBenefits = ((pi.benefits as Row[]) ?? [])
    .filter((b) => { const r = str(b.role); return r === "lead" || r === "supporting"; })
    .map((b) => str(b.benefit_name).trim())
    .filter((n) => n && !isInternalAngleLabel(n));
  const supportingBenefits = [
    ...supportingBenefitsBase,
    ...ourListedBenefits.filter((n) => !supportingBenefitsBase.some((b) => b.toLowerCase() === n.toLowerCase())),
  ].slice(0, 8);

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

  // swap-competitor-offer-slot-for-our-grounded-proof-benefit-or-feature-in-debrand Phase 1 —
  // derived product features (ingredient count) as the LAST-RESORT substitute pool. Populated
  // whenever pi.ingredients carries rows so `chooseGroundedSubstitute` has a grounded fallback
  // when proofStack / benefits / leadProof are all empty. Rarely fires (proofStack is usually
  // rich) but keeps the substitute chooser closed under empty briefs.
  const productFeatures: string[] = [];
  const ingredientCount = Array.isArray(pi.ingredients) ? pi.ingredients.length : 0;
  if (ingredientCount > 0) {
    productFeatures.push(`${ingredientCount} superfoods per serving`);
  }

  // Preserve competitor copy DNA (dahlia-preserve-competitor-copy-dna-debranded Phase 1). The
  // creative-agent competitor-angle mapper (creative-agent.ts stockProduct) threads the
  // underlying skeleton's advertiser + hook + framework + mechanism_claim + proof + offer via
  // `angle.raw` so we can populate the four slots without a second DB read. Own-brand angles
  // leave the field unset. The RAW hook (pre-sanitizer) is carried so Dahlia's author session
  // can see the winner's original words before applying `debrandForOurBrand` at author time.
  //
  // ── swap-competitor-offer-slot-for-our-grounded-proof-benefit-or-feature-in-debrand Phase 1 ──
  // When the competitor's offer slot (or the raw hook) carries an OFFER we do not run (free
  // tote / free gift / bonus item / discount), SWAP it for a grounded selling point from OUR
  // brief (proofStack proof point → supportingBenefit → leadProof → derived feature). Preserves
  // the WINNING STRUCTURE (the framework / mechanism / proof survives) while grounding the
  // promise so downstream gates (firewall claim-miss on ungrounded freebie, cold-offer-leak on
  // discount to cold audience) can pass. The brief's REAL offer (`brief.offer`, populated from
  // our own pricing above) is a different type and is never touched — only the competitor's
  // un-runnable offer is swapped.
  let competitorDna: CreativeBrief["competitorDna"];
  if (angle.source === "competitor") {
    const raw = angle.raw ?? {};
    const rawHookInput = typeof raw.hook === "string" && raw.hook ? raw.hook : angle.hook;
    const framework = typeof raw.framework === "string" ? raw.framework : null;
    const mechanismClaim = typeof raw.mechanismClaim === "string"
      ? raw.mechanismClaim
      : typeof raw.mechanism === "string" ? raw.mechanism : null;
    const proof = typeof raw.proof === "string" ? raw.proof : null;
    const rawOfferInput = typeof raw.offer === "string" ? raw.offer : null;
    const competitorAdvertiser = typeof raw.advertiser === "string" ? raw.advertiser : null;

    // Substitute is chosen ONCE from the brief data available so far. Priority is offer-for-
    // offer first: OUR real brief.offer (free shipping with Subscribe & Save) is preferred as
    // the swap-in so the ad's OFFER POSITION survives without leading on a coupon. Only when
    // brief.offer is null does the chooser fall back to the grounded proof/benefit/feature
    // chain (proofStack → supportingBenefits → leadProof → productFeatures). Null when
    // nothing is available at all; the offer slot then becomes null and the hook keeps only
    // its structural words.
    const substitute = chooseGroundedSubstitute({
      offer,
      proofStack,
      supportingBenefits,
      leadProof,
      productFeatures,
    });

    // OFFER SLOT — if the competitor's offer is an un-runnable OFFER, swap it for the grounded
    // substitute (or null). A slot that ISN'T an offer (e.g. a plain framework line the source
    // row happened to put in `offer`) passes through untouched.
    const swappedOffer = rawOfferInput && isCompetitorOffer(rawOfferInput) ? substitute : rawOfferInput;

    // HOOK — strip a lingering offer phrase from the raw hook so the winning structure survives
    // without the freebie. When stripping would leave the hook empty (offer WAS the entire hook)
    // fall back to `[substitute] + surviving structure` so Dahlia still sees the winner's shape;
    // when nothing survives, keep the pre-strip hook (Dahlia's SKILL handles empty gracefully).
    let hookOut = rawHookInput;
    if (isCompetitorOffer(rawHookInput)) {
      const stripped = stripCompetitorOffer(rawHookInput);
      if (stripped) {
        hookOut = substitute ? `${substitute} ${stripped}` : stripped;
      }
    }

    competitorDna = {
      hook: hookOut,
      framework,
      mechanismClaim,
      proof,
      offer: swappedOffer,
      competitorAdvertiser,
    };
  }

  // dahlia-researches-from-winners-flow-ad-library Phase 1 — surface the WINNER-CONCEPT unified
  // breakdown for competitor imitations. `stockProduct` threads it onto `angle.conceptTags`
  // (canonical field) AND `angle.raw.conceptTags` (compat with pre-existing raw pass-through),
  // so we accept either. Own-brand angles leave the field null. Downstream: Dahlia's session
  // reads it alongside `competitorDna`, and Max's Phase 2 grader benchmarks against it.
  let conceptTags: CreativeBrief["conceptTags"] = null;
  if (angle.source === "competitor") {
    if (angle.conceptTags) {
      conceptTags = angle.conceptTags;
    } else if (angle.raw && typeof angle.raw === "object") {
      const raw = angle.raw as Record<string, unknown>;
      const rawTags = raw.conceptTags;
      if (rawTags && typeof rawTags === "object" && !Array.isArray(rawTags)) {
        conceptTags = rawTags as ConceptTags;
      }
    }
  }

  // dahlia-hooks-riff-competitor-angle-and-weave-in-lead-benefit Phase 2 — WEAVE the product's
  // curated LEAD benefit onto a competitor-source brief so the authored hook must BLEND the
  // competitor's proven framework with our differentiated benefit (a RIFF) — the fix for the
  // 2026-07-18 Amazing Coffee cold creative whose headline led with a purely borrowed commodity
  // hook ('Tired of the coffee jitters?') with our real differentiator (weight loss) nowhere
  // in it. The RIFF is the STRONG DEFAULT for every competitor imitation; `opts.pureCompetitor`
  // is the MINORITY explore-slot escape hatch stockProduct reserves per batch (at most one) so
  // we still ship one pure-borrow imitation for learning. Missing role='lead' benefit → null
  // (degrades gracefully to today's behavior). Own-brand angles are never woven — their hook
  // already carries the benefit.
  let leadBenefitWeave: CreativeBrief["leadBenefitWeave"] = null;
  if (angle.source === "competitor" && !opts.pureCompetitor) {
    const leadBenefitRow = (pi.benefits as Row[]).find((b) => str(b.role) === "lead");
    if (leadBenefitRow) {
      const name = str(leadBenefitRow.benefit_name).trim();
      const phrases = Array.isArray(leadBenefitRow.customer_phrases)
        ? (leadBenefitRow.customer_phrases as unknown[]).map(str).filter(Boolean)
        : [];
      if (name) leadBenefitWeave = { benefitName: name, softPhrasings: phrases.slice(0, 5) };
    }
  }
  if (leadBenefitWeave) {
    guardrails.push(
      `RIFF: lead benefit '${leadBenefitWeave.benefitName}' must weave into the competitor angle`,
    );
  }

  return { productTitle, angle, authorNotes: opts.authorNotes?.trim() || null, leadProof, transformation, supportingBenefits, proofStack, offer, imageRefs, guardrails, competitorDna, conceptTags, leadBenefitWeave, productFeatures };
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
