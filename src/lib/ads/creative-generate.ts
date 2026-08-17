/**
 * creative-generate — turns a fully-backed [[creative-brief]] into an actual static ad via Nano Banana Pro
 * ([[gemini]] `generateNanoBananaProCombine`). Deterministic prompt assembly from the brief's structured
 * fields — the acquisition hook leads, retention truths ride in the body, proof is real, and price appears
 * ONLY via an allowed treatment (never bare MSRP). The Ad Creative Agent (a Max-session lane) calls this,
 * then VISUALLY QAs the result (garbled text / fabrication / price) and regenerates on fail before landing
 * it in Bianca's ready-to-test bin. See [[../../../docs/brain/reference/meta-scaling-methodology]].
 */
import type { CreativeBrief } from "@/lib/ads/creative-brief";
import { errText } from "@/lib/error-text";
import { generateNanoBananaProCombine, type NanoBananaAspect } from "@/lib/gemini";
import { compositeCopyOverlay, type OverlayCopy } from "@/lib/ads/creative-overlay";
import { buildSideBySide } from "@/lib/ads/creative-side-by-side";
import type { SkeletonElement } from "@/lib/ads/decision-engine";

// ── Render-side no-competitor-leak guard ────────────────────────────────────
// The copy-side no-competitor-leak gate only inspects TEXT; a leak that lives in the pixels
// (a competitor's 'free tote' offer graphic baked into the Feed 4:5 render) passed unseen —
// the 2026-07-18 Superfoods Tabs regression that seeded this file's guard. The competitor's
// promotional freebie (tote / free gift / bonus item / GWP / giveaway) is NOT part of our
// real store offer; on a composition-transfer path the model sees the competitor's ad as
// design reference and can carry the freebie ARTIFACT into our render even when the copy
// stays clean. Twin of `sanitizeCompetitorHook` in `creative-brief` — that helper strips
// discount NUMBERS from a competitor hook before it becomes copy; these patterns strip
// GRAPHIC ARTIFACT tokens from the composed RENDER prompt so the model isn't seeded with
// them, and are ALSO negative-prompted into the model instructions (below) for every
// format render (Feed / Reels / Stories / Feed-JPG all share `buildPrompt`).
const RENDER_COMPETITOR_OFFER_PATTERNS: readonly RegExp[] = [
  /\bfree\s+tote\b/gi,
  /\bfree\s+gift\b/gi,
  /\bfree\s+bag\b/gi,
  /\bbonus\s+(?:item|gift|pack|tote|bag)\b/gi,
  /\bgift\s+with\s+purchase\b/gi,
  /\bgwp\b/gi,
  /\bgiveaway\b/gi,
  // Standalone "tote" — the specific artifact that seeded the 2026-07-18 Feed leak. A
  // real Superfoods product is never a tote, so the token is safe to strip wholesale from
  // any RENDER prompt (this is not applied to product copy — only to prompt composition).
  /\btote\b/gi,
];

/** Sentinel header that marks the start of the negative-prompt / hard-rules block in the
 *  composed prompt (see `buildPrompt`). The render-side guard scans ONLY the composed
 *  CONTENT above this marker — the hard-rules block below enumerates the artifact tokens
 *  by name to negative-prompt the model, and scanning the whole prompt would false-positive
 *  on our own enumeration ("NO tote, NO free gift…"). Kept as a module-level constant so
 *  the two halves stay in lockstep. */
const NEGATIVE_PROMPT_MARKER = "OFFER FIDELITY (hard rule)";

/**
 * Pure guard — does the CONTENT portion of the composed render prompt (everything above
 * the hard-rules block starting at `NEGATIVE_PROMPT_MARKER`) still contain a competitor-
 * offer artifact token (free tote / free gift / bonus item / gift-with-purchase /
 * giveaway)? Deterministic + pure. The scan excludes the hard-rules block by design
 * because that block negative-prompts the model with the same token names by intent (a
 * NEGATIVE prompt has to enumerate what NOT to render). Used by `generateCreative` on
 * the composition-transfer path as belt-and-suspenders after the strip helper + the
 * negative-prompt clause: if a token still survives all three layers we refuse to hand
 * the prompt to Nano Banana and let the caller's retry loop take another attempt instead
 * of shipping the leak.
 */
export function renderPromptHasCompetitorOffer(prompt: string): boolean {
  const idx = prompt.indexOf(NEGATIVE_PROMPT_MARKER);
  let scanRegion = idx >= 0 ? prompt.slice(0, idx) : prompt;
  // Exclude the TRUSTED human-instruction clauses (CEO edit / owner "Generate ad like this"
  // directions). A human may legitimately say "remove the free tote badge" — the guard exists to
  // catch a competitor freebie that LEAKED into the machine-composed content, not to reject the
  // owner telling us to strip one. Without this, "Remove the free tote badge" false-tripped the guard
  // and failed the whole generation (the 2026-07-20 Bloom→Amazing Creamer pinned run). Each clause
  // runs from its sentinel header to the next blank line.
  scanRegion = stripHumanInstructionClauses(scanRegion);
  for (const re of RENDER_COMPETITOR_OFFER_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(scanRegion)) return true;
  }
  return false;
}

/** PURE — remove the CEO-edit + owner-directions clauses (each a `${HEADER} … up to the next blank
 *  line`) from a scan region, so the competitor-offer guard never false-positives on a human's
 *  instruction that NAMES an artifact to remove. */
function stripHumanInstructionClauses(region: string): string {
  let out = region;
  for (const header of [CEO_EDIT_HEADER, AUTHOR_NOTES_HEADER]) {
    const h = out.indexOf(header);
    if (h < 0) continue;
    const end = out.indexOf("\n\n", h);
    out = out.slice(0, h) + (end >= 0 ? out.slice(end) : "");
  }
  return out;
}

/**
 * Strip competitor-offer artifact tokens (tote / free gift / bonus item / GWP / giveaway)
 * out of a text fragment that will be composed into the render prompt. Deterministic +
 * pure. Collapses whitespace + trims orphan punctuation left behind, so the debranded
 * competitor hook reads naturally after the scrub. Only applied to prompt-composition
 * inputs — never to customer copy.
 */
export function stripCompetitorOfferArtifacts(text: string): string {
  let out = text;
  for (const re of RENDER_COMPETITOR_OFFER_PATTERNS) out = out.replace(re, " ");
  out = out.replace(/\s+[—–\-|·+&]\s+/g, " ");
  out = out.replace(/^[\s,;:.|\-·—–+&]+|[\s,;:.|\-·—–+&]+$/g, "");
  out = out.replace(/\s{2,}/g, " ").trim();
  return out;
}

/** Sentinel error thrown by `generateCreative` when the composed prompt still carries a
 *  competitor-offer artifact token after the strip helper + negative clause both ran.
 *  Caught by the ad-creative retry loop in `creative-agent.ts` and surfaced as a regen
 *  reason (never persisted — this is a bug in the strip layer surfaced loudly). */
export class RenderPromptCompetitorOfferError extends Error {
  constructor(prompt: string) {
    super(`render_prompt_has_competitor_offer: composed prompt still contains a competitor freebie artifact token after strip + negative clause. Prompt head: ${prompt.slice(0, 200)}…`);
    this.name = "RenderPromptCompetitorOfferError";
  }
}

export interface GenerateCreativeOpts {
  aspectRatio?: NanoBananaAspect; // default "4:5" (Meta feed)
  /** A proven winner to match design language (e.g. the skeptic winner). Passed as the FIRST image. */
  designReferenceUrl?: string;
  /** Creative treatment/archetype — how the concept is executed. Varies the COMBINATION so a concept can
   *  be re-tested different ways (CEO 2026-07-10). before_after → the transformation leads; testimonial →
   *  a real review leads; big_claim → the headline claim dominates; authority → proof/certs lead;
   *  advertorial → an editorial story frame. Default: before_after. */
  treatment?: "before_after" | "testimonial" | "big_claim" | "authority" | "advertorial";
  /** Composition transfer (CEO 2026-07-11): the `designReferenceUrl` is a PROVEN competitor static —
   *  reuse its winning COMPOSITION (layout/hierarchy/focal structure) but swap in OUR product + copy +
   *  proof. A static wins on composition, not just its text. */
  compositionTransfer?: boolean;
  /** ceo-feedback-render-edits-the-existing-ad-format-in-place-not-a-new-whole-pack-ad Phase 1 —
   *  the CEO's per-format revise reason threaded from the ad-review-feedback router. When set,
   *  `buildPrompt` emits a top-of-prompt `CEO EDIT (apply exactly to this format)` clause so the
   *  render actually applies the surgical note ("make the product bigger", "change the 'free tote'
   *  badge to 'Free Shipping with Subscribe and Save'", "change the overlay text to …") instead of
   *  drifting back to a generic fresh render. Absent (normal fresh-pack path) → no clause emitted,
   *  the prompt is byte-identical to today. */
  ceoReviseReason?: string;
  /** dahlia-imitates-the-pinned-ad-structure-instead-of-redesigning-it Phase 3 — the source
   *  (pinned/imitated competitor) ad's stored WIREFRAME: its element/zone/prominence map, how
   *  the product is presented (packshot / held-in-hand / lifestyle / before_after), and the copy
   *  rhythm from its `punchiness` tags. When present, `buildPrompt` emits a binding `SOURCE
   *  STRUCTURE (reproduce this layout):` clause IMMEDIATELY after the composition-transfer
   *  refClause (Nano Banana weighs earliest instructions heaviest), enumerating the elements in
   *  reading order (zone → role → prominence), stating the product presentation verbatim, stating
   *  the copy rhythm from punchiness tags, and forbidding invention of any element type not in
   *  the map. Absent (own-brand angle / pre-extractor skeleton) → the prompt is byte-identical
   *  to today. Reuses `SkeletonElement` from [[./decision-engine]] so the shape stays in lockstep
   *  with the substitution engine's own contract. */
  sourceWireframe?: {
    elements: SkeletonElement[];
    productPresentation: string[];
    punchiness: string[];
  } | null;
  /** ⭐ CEO 2026-08-17 (#1 — "one ad, three ratios, not three different ads"). The CANONICAL
   *  placement's finished render as a `data:` URI, handed to every SIBLING placement so the pack is
   *  ONE creative re-laid-out per aspect rather than three independent imaginings of one brief.
   *  Observed on ad dcd6d536: the 4:5 was a packshot ad and the 9:16 a completely different
   *  before/after transformation ad. Absent (i.e. the canonical's own render) → byte-identical to
   *  the previous prompt. */
  canonicalRenderDataUrl?: string;
  /** ⭐ CEO 2026-08-17 (#3 — the pack renders too narrow). Real printed pack size from
   *  `product_variants.package_dimensions`, so the render reproduces the pouch's true proportions
   *  instead of inferring them. Absent → no clause emitted. */
  packageDimensions?: PackageDimensions;
}

/** ⭐ CEO 2026-08-17 (#3). Real printed pack size, stored per-variant so a render never guesses the
 *  silhouette. Any subset may be present — the clause names only what is known. */
export interface PackageDimensions {
  widthMm?: number | null;
  heightMm?: number | null;
  depthMm?: number | null;
}

/** Pure. The pack-dimension clause; empty when nothing usable is known, so a product without
 *  measured packaging renders byte-identically to before. */
export function formatPackageDimensionsClause(dims?: PackageDimensions | null): string {
  if (!dims) return "";
  const parts: string[] = [];
  if (dims.widthMm) parts.push(`${dims.widthMm}mm wide`);
  if (dims.heightMm) parts.push(`${dims.heightMm}mm tall`);
  if (dims.depthMm) parts.push(`${dims.depthMm}mm deep`);
  if (!parts.length) return "";
  const ratio =
    dims.widthMm && dims.heightMm
      ? ` Its width-to-height ratio is ${(dims.widthMm / dims.heightMm).toFixed(2)}:1 — match that silhouette exactly. A pouch rendered narrower than its real proportions reads as a different product.`
      : "";
  return `\n\nPACK PROPORTIONS (render the product at its REAL size): the physical pack is ${parts.join(" × ")}.${ratio}`;
}

/** ⭐ CEO 2026-08-17 (#1). Sentinel header for the same-ad-new-ratio clause a sibling placement
 *  receives. Grep-able so a test can prove siblings are re-layouts, not fresh concepts. */
export const SAME_AD_NEW_RATIO_HEADER = "SAME AD — NEW RATIO (this is a re-layout, not a new concept):";

/** Pure. The clause that turns a sibling render into a re-layout of the canonical. */
export function formatSameAdNewRatioClause(hasCanonical: boolean, aspectRatio: string): string {
  if (!hasCanonical) return "";
  return (
    `\n\n${SAME_AD_NEW_RATIO_HEADER} the FIRST image is the FINISHED canonical version of THIS EXACT AD. ` +
    `Reproduce it at ${aspectRatio}: the same concept, same headline wording, same hero product shot, same props, ` +
    `same colour treatment, same proof elements, same overall feel. You are RE-FLOWING one finished ad into a new ` +
    `frame — moving and rescaling what is already there so it composes correctly at ${aspectRatio} — NOT designing a ` +
    `second ad from the same brief. Do NOT introduce any element the canonical does not have (no new photos, no ` +
    `before/after panels, no extra badges), and do NOT drop an element it does have. A viewer seeing both side by ` +
    `side must recognise them as the same ad in two sizes.`
  );
}

/** ceo-feedback-render-edits-the-existing-ad-format-in-place-not-a-new-whole-pack-ad Phase 1 —
 *  header sentinel a unit test can grep for to prove the CEO note landed at the TOP of the composed
 *  prompt (Nano Banana's instruction-following weighs the earliest lines heaviest). Same-file
 *  constant so buildPrompt + tests never drift. */
export const CEO_EDIT_HEADER = "CEO EDIT (apply exactly to this format):";
/** Sentinel header for the owner's up-front "Generate ad like this" free-text directions (Research ›
 *  Ads). A test greps for it; distinct from CEO_EDIT_HEADER (a post-review surgical edit). */
export const AUTHOR_NOTES_HEADER = "OWNER DIRECTIONS (apply exactly to this ad):";

const TREATMENT_STEER: Record<NonNullable<GenerateCreativeOpts["treatment"]>, string> = {
  before_after: "TREATMENT: before/after transformation-led — the two-photo transformation is the hero.",
  testimonial: "TREATMENT: testimonial-led — a real 5-star customer review + name is the visual hero (photoreal, no fake badges); product secondary.",
  big_claim: "TREATMENT: big-claim — one bold benefit headline dominates the frame; minimal other elements.",
  authority: "TREATMENT: authority — lead with the proof stack (3rd-party tested, non-GMO, award, guarantee) as the credibility hero.",
  advertorial: "TREATMENT: advertorial — an editorial / 'article'-style layout (headline + body-copy feel), not a glossy ad.",
};

export interface GeneratedCreative {
  buffer: Buffer;
  mimeType: string;
  prompt: string;
  /** The exact copy strings the QA pass must verify render correctly (no garble). */
  expectedCopy: { headline: string; offer: string | null; trust: string };
  /** dahlia-competitor-ad-adaptation-overlay-render Phase 4 — the [competitor | ours]
   *  side-by-side composite the vision judge grades for (a) energy match-or-surpass and
   *  (b) preserved psychological structure. Present ONLY on the overlay path when a
   *  competitor design reference was supplied (the only path where the prime-directive
   *  side-by-side is meaningful — an own-brand angle has no source to grade against).
   *  Consumed by [[creative-agent]] `stockProduct`'s regen loop: hands the buffer to the
   *  vision judge, calls `sideBySideGate` on the verdict, revises in-session on fail
   *  (mirrors the existing MAX_QA_ATTEMPTS bounce). See [[creative-side-by-side]]. */
  sideBySide?: { buffer: Buffer; mimeType: string };
}

/** dahlia-imitates-the-pinned-ad-structure-instead-of-redesigning-it Phase 3 — sentinel header
 *  the render prompt emits when a source wireframe is supplied. A unit test can grep this
 *  literal to prove the binding layout clause landed IMMEDIATELY after `refClause` (earliest
 *  instructions weigh heaviest in Nano Banana). Same-file constant so buildPrompt + any future
 *  test never drift. */
export const SOURCE_STRUCTURE_HEADER = "SOURCE STRUCTURE (reproduce this layout";

/** Reading-order for the wireframe listing — mirrors the layout zones a viewer scans in on a
 *  4:5 / 9:16 static ad. Zones absent from an element list simply don't render. */
const WIREFRAME_ZONE_ORDER: readonly SkeletonElement["zone"][] = ["header", "hero", "body", "footer", "cta"] as const;
/** The full role vocabulary from [[./decision-engine]] `SkeletonElement.role`. When emitting
 *  the "do NOT invent" clause we name the roles the source ad OMITS so the model doesn't
 *  free-associate a proof bar, price sticker, or risk-reversal badge the source didn't carry. */
const WIREFRAME_ALL_ROLES: readonly SkeletonElement["role"][] = [
  "hook", "mechanism", "proof", "offer", "risk_reversal", "social_proof", "price",
] as const;

/** PURE — turn the source ad's stored wireframe into the render prompt's SOURCE STRUCTURE
 *  clause. Empty wireframe (no elements + no presentation + no punchiness) → empty string, so
 *  a `sourceWireframe`-absent OR fully-empty prompt is byte-identical to today. */
function formatSourceStructureClause(
  wf: { elements: SkeletonElement[]; productPresentation: string[]; punchiness: string[] } | null | undefined,
): string {
  if (!wf) return "";
  const sortedElements = [...wf.elements].sort((a, b) => {
    const dz = WIREFRAME_ZONE_ORDER.indexOf(a.zone) - WIREFRAME_ZONE_ORDER.indexOf(b.zone);
    if (dz !== 0) return dz;
    return b.prominence - a.prominence;
  });
  if (sortedElements.length === 0 && wf.productPresentation.length === 0 && wf.punchiness.length === 0) return "";
  const elementLines = sortedElements
    .map((e) => `- ${e.zone} · ${e.role} (prominence ${e.prominence})`)
    .join("\n");
  const presentationLine = wf.productPresentation.length
    ? `PRODUCT PRESENTATION (render the product exactly this way, verbatim from the source ad): ${wf.productPresentation.join(", ")}.`
    : "";
  const punchinessLine = wf.punchiness.length
    ? `COPY RHYTHM (match this cadence exactly): ${wf.punchiness.join(", ")}.`
    : "";
  const rolesPresent = new Set(sortedElements.map((e) => e.role));
  const rolesOmitted = WIREFRAME_ALL_ROLES.filter((r) => !rolesPresent.has(r));
  const noInvent = elementLines
    ? `Do NOT invent any element type not in this list${rolesOmitted.length ? ` — specifically, do NOT add a ${rolesOmitted.join(" / ")} panel, bar, badge, sticker, or caption the source ad does not have` : ""}. No extra panels, no extra proof bars, no photo splits, and no CTA buttons the source ad does not carry.`
    : "";
  const bodyLines = [elementLines, presentationLine, punchinessLine, noInvent].filter(Boolean).join("\n");
  return `\n\n${SOURCE_STRUCTURE_HEADER} — this is BINDING; the source ad's own map is the treatment. Reproduce THIS structure, filled with OUR content):\n${bodyLines}`;
}

export function buildPrompt(
  brief: CreativeBrief,
  hasDesignRef: boolean,
  treatment?: GenerateCreativeOpts["treatment"],
  compositionTransfer?: boolean,
  ceoReviseReason?: string,
  sourceWireframe?: GenerateCreativeOpts["sourceWireframe"],
  /** ⭐ CEO 2026-08-17 — the real output ratio. Was hardcoded to "4:5" in three places, so every
   *  9:16 / 1:1 sibling was literally instructed "Design a 4:5 static ad … Output 4:5" while the
   *  API rendered a different frame. That mismatch is a direct cause of siblings composing as
   *  their own ads rather than re-layouts. */
  aspectRatio: string = "4:5",
  /** ⭐ CEO 2026-08-17 (#1) — canonical render supplied ⇒ this is a sibling re-layout. */
  hasCanonicalReference: boolean = false,
  /** ⭐ CEO 2026-08-17 (#3) — real pack proportions. */
  packageDimensions?: PackageDimensions | null,
): { prompt: string; expectedCopy: GeneratedCreative["expectedCopy"] } {
  // For a COMPOSITION-TRANSFER (competitor imitation), the angle.hook is the COMPETITOR's proven hook —
  // it may carry THEIR brand/product name (e.g. "MUD\WTR Mushroom Tea Blend - Up to 43% Off"). Rendering
  // it verbatim over OUR packshot is a brand mismatch the QC gate correctly rejects (2026-07-13). So for
  // an imitation we DON'T lock the exact competitor string as the headline — we tell the model to echo the
  // hook's STRUCTURE while naming ONLY our product, and QC verifies OUR product name renders (ungarbled)
  // instead of demanding the competitor string. A normal (own-brand) angle keeps render-exact behavior.
  const isImitation = !!compositionTransfer && hasDesignRef;
  // Render-side no-competitor-leak (Phase 1) — on the imitation path the competitor's
  // debranded hook may still carry a freebie ARTIFACT ("Free tote with subscription")
  // that our copy-side sanitizer doesn't scrub (it only strips DISCOUNT numbers). Strip
  // those artifact tokens before the hook becomes the headline the model must echo, so
  // the model isn't seeded with the competitor's freebie language. Own-brand angles
  // pass through unchanged — no competitor DNA to leak.
  const headline = isImitation ? stripCompetitorOfferArtifacts(brief.angle.hook) : brief.angle.hook;
  const trust = brief.proofStack.slice(0, 4).join(" · ");
  const treatmentClause = treatment ? `\n${TREATMENT_STEER[treatment]}` : "";
  // Price: allowed treatments only. Prefer the offer headline; if a number is warranted, per-serving or strikethrough.
  const priceLine = brief.offer
    ? (brief.offer.perServing ?? brief.offer.strikethrough ?? brief.offer.headline)
    : null;
  const offerHeadline = brief.offer?.headline ?? null;

  const refClause = compositionTransfer && hasDesignRef
    ? "The FIRST image is a PROVEN, high-performing competitor ad. REUSE ITS WINNING COMPOSITION — the visual hierarchy, focal structure, where imagery vs text sit, the negative space, the scroll-stopping energy. But REPLACE every piece of its CONTENT with OURS: swap the competitor's product for OUR product (from the other provided images), and use OUR headline / proof / offer below. Change everything that identifies the competitor (their brand name, product, logo, claims, any of their text) — copy the STRUCTURE, never their words or marks. Produce ONE cohesive, polished direct-response static built around a single hero product shot — NEVER a stacked list of blue links, sitelinks, a button/menu column, or a search-result layout (even if the reference looks like that)."
    : hasDesignRef
    ? "Match the FIRST image's design language (layout energy, typography weight, color system) — the product images follow it."
    : "Clean, premium direct-response e-commerce static; high contrast; mobile-thumb-legible.";

  // dahlia-imitates-the-pinned-ad-structure-instead-of-redesigning-it Phase 3 — the source ad's
  // stored WIREFRAME lands here, IMMEDIATELY after `refClause` (earliest instructions weigh
  // heaviest in Nano Banana), so the binding layout the extractor already knows travels with
  // the reference image instead of being drowned by the ~150 words of downstream instructions.
  // Absent (own-brand angle / pre-extractor skeleton) → empty string, prompt byte-identical.
  const sourceStructureClause = formatSourceStructureClause(sourceWireframe);

  const bodyBits: string[] = [];
  // dahlia-imitates-the-pinned-ad-structure-instead-of-redesigning-it Phase 1 — the two-photo
  // before/after paragraph fires ONLY when `renderBeforeAfter === true` (an EXPLICIT signal
  // via `shouldRenderBeforeAfter`), not merely because a transformation object was attached.
  // When the object exists but the flag is false, fall through to the ordinary review-proof
  // line so the real reviewer quote + name still render as text (the leadProof was set to the
  // transformation's quote in `buildCreativeBrief` for that exact reason).
  if (brief.transformation?.renderBeforeAfter) {
    const img = brief.transformation.beforeAfterImage
      ? "Anchor it on the REAL before/after image PROVIDED (don't alter the person)"
      : "Anchor it on a before/after WEIGHT-LOSS transformation shown as TWO SEPARATE side-by-side FULL-BODY photographs of the SAME woman, standing, head-to-knee or head-to-toe, in fitted clothing (leggings + fitted top) so the PHYSIQUE change is clearly visible: a clear BEFORE (visibly heavier) on the left and an AFTER (noticeably slimmer, toned, happy) on the right. In the AFTER photo she is holding a tall glass of the prepared product beverage (the same iced drink shown with the product) — it ties the transformation to the product. This is a BODY transformation — NOT a face close-up, NOT skincare-style, NOT a single face split down the middle, NOT a morph, NOT the same photo twice. PHOTOREALISTIC (natural skin, real lighting), never an illustration, cartoon, drawing, 3D render, or CGI. Small 'Before' and 'After' corner labels are OK; put NO other text on the photos — no 'candid photo', no claim it is a real/verified/documentary image";
    bodyBits.push(`${img}. Elsewhere in the layout (not on the photos), show the customer quote "${brief.transformation.quote.slice(0, 90)}" — ${brief.transformation.reviewer}. The quote + name are a GENUINE review — render them EXACTLY, never alter or invent them.`);
  } else if (brief.leadProof?.kind === "review") {
    bodyBits.push(`Support the headline with the real customer quote "${brief.leadProof.text.slice(0, 90)}"${brief.leadProof.attribution ? ` — ${brief.leadProof.attribution}` : ""} (a genuine review).`);
  } else if (brief.leadProof) {
    bodyBits.push(`Support the headline with the proof point: "${brief.leadProof.text.slice(0, 90)}".`);
  }
  if (brief.supportingBenefits.length) bodyBits.push(`Small secondary line reinforcing: ${brief.supportingBenefits.slice(0, 2).join(", ")}.`);

  // A competitor design reference frequently contains THEIR customer review / testimonial / star
  // rating. On a composition transfer the model reuses the layout and copies their review words
  // verbatim unless told otherwise — a fabricated testimonial (their words, not about our product).
  // Whether we PROVIDED our own review above decides the rule: swap in ours, or render none.
  const hasProvidedReview = !!brief.transformation || brief.leadProof?.kind === "review";

  // HEADLINE clause — imitation vs own-brand (see isImitation note above).
  const headlineClause = isImitation
    ? `HEADLINE: the proven competitor angle to ECHO is "${headline}". ⭐ RAIL 0, BEATS EVERYTHING BELOW (CEO 2026-08-17): a THIRD-PARTY TRADEMARK or brand name never survives, no matter how well the line works. Not the competitor's own brand, and not a brand THEY named — a drug, a retailer, another product. Erth Labs' "Meet Nature's Ozempic" is the worked case: Ozempic is Novo Nordisk's prescription trademark, so it cannot appear on our ad even though the hook is excellent and the competitor ran it. When a trademark carries the hook, KEEP THE DEVICE AND SUBSTITUTE THE NOUN — the reframe is the asset, the trademark is just how they filled the slot. "Meet Nature's Ozempic" becomes "Nature's Way To Curb Cravings": same nature-versus-pharma framing, same us-vs-them energy, no trademark. Never resolve this by falling back to a flat benefit restatement — substitute within the device. ⭐ OTHERWISE, ECHO THE WORDS WHEN THEY APPLY TO US. The test is TRUTH ABOUT OUR PRODUCT, never where the words came from. That hook won on a specific rhetorical MOVE — a reframe, a category comparison, a curiosity gap, an accusation, a contrarian flip — and the move usually lives IN the wording. So DEFAULT TO KEEPING THE LINE, close to verbatim, and change only the specific words that fail the truth test below. A hook carrying no competitor brand name, no untrue attribute and no unverified number is a CATEGORY TRUTH we are equally entitled to say — keep it. Collapsing a sharp reframe into a flat benefit restatement (e.g. "Meet Nature's Ozempic" → "Appetite Suppression And Weight Loss In A Cup") throws away the exact thing worth imitating and is the #1 failure of this path; the literal restatement is never the right answer. THE TRUTH TEST, applied word by word: (1) ATTRIBUTE / ingredient descriptor — KEEP it if it is genuinely true of ${brief.productTitle}; swap in our real equivalent only when it is not (their "protein coffee" when we are not a protein coffee). (2) BENEFIT / RESULT / PROMISE — KEEP it if ${brief.productTitle} actually delivers it, including when the competitor happens to say it first and says it well; drop it only when we do not deliver it. Do not discard a benefit merely because a competitor used the phrase. (3) SPECIFIC NUMBER, TIMEFRAME OR PERCENTAGE — keep ONLY when it is a verified fact about ${brief.productTitle} ("10 weeks", "lose 40 lbs", "3x"); an unverified figure carried over is a FABRICATION, not an imitation. Never render another company's BRAND NAME, product name or trademark anywhere. Big, bold, correctly spelled, 1-2 key phrases highlighted in a color block.`
    : `HEADLINE (render EXACTLY, correct spelling, no dropped/repeated words): "${headline}" — big, bold, with 1–2 key phrases highlighted in a color block.`;

  // When the render is not emitting a before/after image, the model must NOT free-associate a
  // weight-loss before/after — it did exactly that on 2 of 4 competitor imitations (2026-07-13),
  // a fabricated result the QC gate then (correctly) rejected. Forbid it explicitly so the render
  // doesn't waste a generation on an auto-reject. Keyed on `renderBeforeAfter` — a transformation
  // object attached only for text-proof purposes (flag=false) must still trigger this hard clause.
  const noTransformationRule = brief.transformation?.renderBeforeAfter
    ? ""
    : ` This ad has NO transformation: do NOT render any before/after, weight-loss, body-comparison, results-timeline, or "BEFORE"/"AFTER" imagery, panel, or caption of ANY kind — no implied physical-result story.`;

  // ceo-feedback-render-edits-the-existing-ad-format-in-place-not-a-new-whole-pack-ad Phase 1 —
  // when the CEO left a per-format revise reason on the review card, the router hands it to us as
  // the exact edit to apply. Emit it as the FIRST clause after the ad's setup line (Nano Banana
  // weighs earliest instructions heaviest) with a sentinel header (`CEO_EDIT_HEADER`) a test can
  // grep for. Absent (normal fresh-pack path) → empty string, prompt is byte-identical to today.
  const ceoNote = ceoReviseReason?.trim();
  const ceoEditClause = ceoNote
    ? `\n\n${CEO_EDIT_HEADER} the CEO reviewed this exact ad and left a targeted instruction. Apply it EXACTLY — this is a surgical edit to THIS format's existing render, not a redesign. Keep every other element (headline, proof, reviewer, product) unchanged from the composition below unless the note explicitly says otherwise. THE NOTE: "${ceoNote.replace(/"/g, "'")}".`
    : "";

  // Research › Ads "Generate ad like this" free-text notes — the owner's up-front directions for THIS
  // fresh generation ("remove the free tote badge"). Unlike ceoEditClause (a surgical edit to an
  // EXISTING render), this steers the design as it's built. Emitted early (Nano Banana weighs earliest
  // instructions heaviest) so it lands first-pass and skips a manual revise round. Absent → "".
  const briefNote = brief.authorNotes?.trim();
  const authorNotesClause = briefNote
    ? `\n\n${AUTHOR_NOTES_HEADER} the owner asked for this ad and left specific directions. Apply them EXACTLY when designing this ad (they override the generic composition below on any conflict). THE DIRECTIONS: "${briefNote.replace(/"/g, "'")}".`
    : "";

  const sameAdClause = formatSameAdNewRatioClause(hasCanonicalReference, aspectRatio);
  const packDimsClause = formatPackageDimensionsClause(packageDimensions);
  const prompt = `Design a ${aspectRatio} static ad for ${brief.productTitle}. ${sameAdClause}${refClause}${sourceStructureClause}${treatmentClause}${ceoEditClause}${authorNotesClause}${packDimsClause}

${headlineClause}

${bodyBits.join("\n")}

Show the real product (from the provided product image) prominently.

PRODUCT FIDELITY: reproduce the product package faithfully from the provided product image — its real wordmark, colors, and imagery. Keep ONLY the main brand wordmark and product name crisp and legible. For the small ingredient icons, supplement-facts panel, and any other fine print on the package: do NOT try to spell them out — a redrawn pack turns them into gibberish. Render those areas as a clean, softly-defocused, or subtly out-of-focus surface (as a real product photo's fine print looks at ad size), NOT as invented lettering. EVERY piece of text that IS legible anywhere in the image must be real, correctly-spelled English words — never gibberish, fake-latin, scrambled glyphs, or nonsense characters.

TRUST BAR (small, along the bottom, render exactly): ${trust}

OFFER (show ONCE — a single badge, never duplicated): ${offerHeadline ? `one pill/badge reading "${offerHeadline}".` : "none."}${priceLine && brief.offer?.perServing ? ` Next to it, the per-serving value "${priceLine}".` : priceLine && brief.offer?.strikethrough ? ` If a price is shown, ONLY as strikethrough MSRP → discounted: "${priceLine}" with the small disclaimer "${brief.offer?.disclaimer}".` : ""}

OFFER FIDELITY (hard rule): the ONLY discount / percent-off / dollar-off / "free shipping" / BOGO / "X for $Y" claim that may appear ANYWHERE in the image is the OFFER above. Do NOT invent, add, echo, or carry over a different discount number from the headline, subhead, badges, or any other element${offerHeadline ? "" : " (no offer is supplied — the ad must show NO discount claim at all)"}. Two conflicting discount numbers on the same ad is a defect.

CLAIM FIDELITY (hard rule): every product attribute, ingredient, or nutrient descriptor rendered ANYWHERE in the image must be TRUE of ${brief.productTitle} (per the provided packshot + the brief). NEVER describe our product with an attribute it does not have — in particular, do NOT call it a "protein", "keto", "collagen", "pre-workout", or any other nutrient/format claim unless our product actually is that. When echoing a competitor angle, their product's descriptors do NOT transfer — swap in OUR real product nature (shown on the pack). A false attribute claim on our product is a defect.

REVIEW FIDELITY (hard rule): any customer review, testimonial, quote, reviewer name, or star-rating visible in the competitor reference is THEIRS — it is NOT about ${brief.productTitle}. NEVER copy, echo, paraphrase, or render the competitor's review text, reviewer name, or rating. ${hasProvidedReview ? "Render ONLY the customer review provided above — it is a real, featured review of OUR product. You MAY tighten a long review to its strongest, most relevant lines (a faithful condensation is fine), but keep the reviewer NAME exactly as given and never embellish, invent, or add a claim the review does not actually make." : "NO review of our product is provided, so render NO customer review, testimonial, quote, reviewer name, or star-rating anywhere — do NOT invent one and do NOT carry over the competitor's."} Rendering a competitor's (or an invented) review on our ad is a fabricated-testimonial defect.

NO COMPETITOR OFFER (hard rule — applies to EVERY format render: Feed 4:5, Reels 9:16, Stories 9:16, right-column 1:1): a competitor's promotional freebie (a bonus tote, a free gift-with-purchase pouch, a giveaway sticker, a bonus item, a "GWP" badge, a "free bag" callout) is NOT part of OUR real store offer — do NOT paint, render, badge, sticker, tag, or otherwise depict any of these anywhere in the image, even when the design reference clearly carries one. Specifically: NO tote, NO free tote, NO free gift, NO bonus item, NO gift-with-purchase, NO free bag, NO giveaway artifact of any kind. Rendering a competitor's offer graphic on our ad is a defect (the 2026-07-18 Superfoods Tabs Feed leak — the competitor's 'free tote' bled into the pixels while our copy stayed clean).

NO THIRD-PARTY BRANDS (hard rule — EVERY format + EVERY panel incl. any before/after frame): the ONLY branded product, package, logo, wordmark, or label anywhere in the image is OUR own ${brief.productTitle}. NEVER paint, render, or depict any OTHER company's product, can, bottle, box, logo, or recognizable branded item — not the competitor whose composition you are reusing, and not an unrelated brand used to stage a "before" state (NO Red Bull, Monster, Starbucks, or any real energy-drink / coffee / supplement can or bottle; NO recognizable third-party packaging of any kind). To depict a "before" problem state, use a generic, UN-branded prop or a person's expression — never a real brand's product. Rendering any third-party brand on our ad is a trademark/brand-safety defect (the 2026-07-19 Guru Focus render leaked real Red Bull and Monster cans into a before-frame).

HARD RULES: never show a bare MSRP / sticker price alone. The reviewer NAME and QUOTE must be rendered EXACTLY as given (they are real reviews) — never invent a name, alter a quote, or add a fake "verified purchase" checkmark badge.${noTransformationRule} A before/after transformation image must be PHOTOREALISTIC (a real photograph of a real person) — never a cartoon, illustration, drawing, or 3D/CGI render. Every claim must match the copy given (no new claims). Output ${aspectRatio}, no watermark.`;

  // expectedCopy.headline drives the QC exact-headline check. For an imitation we deliberately let the model
  // rewrite the headline off the competitor's brand, so there is no exact string to assert — leave it BLANK,
  // which both QC paths treat as "skip the exact-match, keep textLegible strict" (a productTitle sentinel
  // wrongly rejected a fine de-branded headline "The #1 Superfood Coffee" on 2026-07-13). Own-brand angles
  // still assert their exact hook. The no-competitor-brand guard lives in the generation prompt above.
  return { prompt, expectedCopy: { headline: isImitation ? "" : headline, offer: offerHeadline, trust } };
}

/** Sentinel constant naming the flag that gates the 3-layer overlay render path. Mirrors
 *  `DAHLIA_COPY_MODE` — flip to `"overlay"` to enable the text-free scene + font-engine copy
 *  overlay branch (dahlia-competitor-ad-adaptation-overlay-render Phase 1). Any other value
 *  (including unset) keeps the legacy model-draws-text render as the default. */
export const OVERLAY_RENDER_MODE_FLAG = "overlay";

/** True iff the DAHLIA_RENDER_MODE env flag names the overlay path. Extracted so tests can
 *  assert the gate is a pure env read (no side effects) without stubbing process.env at read time. */
export function isOverlayRenderModeEnabled(): boolean {
  return (process.env.DAHLIA_RENDER_MODE || "").trim() === OVERLAY_RENDER_MODE_FLAG;
}

/** Build the TEXT-FREE scene prompt for Nano Banana Pro on the overlay path. Reproduces the
 *  competitor reference's composition/lighting with OUR product, ZERO added text — the copy
 *  is composited afterwards by `compositeCopyOverlay` with a real font engine. See
 *  [[../../../docs/brain/reference/competitor-ad-adaptation]] Part 2 for the exact rules
 *  (Nano Banana will otherwise sneak in a flavor caption like "CINNAMON LATTE"). Deterministic
 *  + pure. */
export function buildTextFreeScenePrompt(
  brief: CreativeBrief,
  hasDesignRef: boolean,
  compositionTransfer?: boolean,
  /** ⭐ CEO 2026-08-17 — real output ratio (was hardcoded "4:5" on every placement). */
  aspectRatio: string = "4:5",
  /** ⭐ CEO 2026-08-17 (#3) — real pack proportions. */
  packageDimensions?: PackageDimensions | null,
): string {
  const isImitation = !!compositionTransfer && hasDesignRef;
  const refClause = isImitation
    ? "The FIRST image is a PROVEN, high-performing competitor ad. REUSE ITS WINNING COMPOSITION — the visual hierarchy, focal structure, where the product sits, the negative space, the lighting, the mood. But REPLACE its product with OUR product (from the other provided images) and its drink / props / garnish with what fits OUR flavor. Change everything that identifies the competitor (their brand name, product, logo, claims); copy the STRUCTURE, never their words or marks."
    : hasDesignRef
    ? "Match the FIRST image's design language (layout energy, lighting, mood, color system) — the product images follow it."
    : "Clean, premium direct-response e-commerce scene; high contrast; mobile-thumb-legible.";

  return `Design a text-free product scene for ${brief.productTitle}. ${refClause}

TEXT-FREE (hard rule — this is the WHOLE POINT of this render path): absolutely ZERO added text ANYWHERE in the image — no headline, no sub-headline, no benefit words, no callout, no badge, no CTA, no flavor caption (e.g. never render "CINNAMON LATTE", "COFFEE", "PROTEIN", or any flavor / product-name floating in the scene), no price, no percent-off, no reviewer name, no star-rating, no watermark, no logo overlay. The ONLY legible text may be the product's OWN printed pack label as it naturally appears on the packaging — nothing else. The copy is composited afterwards with a real font engine; if you add ANY text, the composited copy will collide with it and the render is unusable.

PRODUCT / SCENE (Part 2 rules from the competitor-ad-adaptation reference):
- Swap product + drink + props to OUR flavor's REAL variant. Use the product image PROVIDED — its real pack, real wordmark, real color. Never fabricate a flavor variant you don't have a real image for.
- RE-LIGHT the product to match the scene: warm rim light + deep shadow falloff + cast shadow + reflection so it looks PHOTOGRAPHED IN the environment, not photoshopped-in. A bright, flat, evenly-lit product on a moody scene is a defect — regenerate.
- Keep the lead packaging FULLY IN FRAME — no clipping at any edge, clear margin around the hero pack. A half-cropped pack reads noob and is a defect.
- Reproduce the pack label faithfully (main brand wordmark + product name crisp), but render the small ingredient icons / supplement-facts panel as a softly-defocused surface (as a real product photo's fine print looks at ad size). Fine-print gibberish is a defect.
- Cluster the product to one side so the scene leaves an L-shaped clean dark zone (top band + a side column) for the copy overlay that lands on top of this base.

NO THIRD-PARTY BRANDS (hard rule): the ONLY branded product, package, logo, wordmark, or label anywhere in the image is OUR own ${brief.productTitle}. NEVER paint, render, or depict any OTHER company's product, can, bottle, box, logo, or recognizable branded item — not the competitor whose composition you are reusing.
${formatPackageDimensionsClause(packageDimensions)}

Output ${aspectRatio}, no watermark.`;
}

/** Fetch the raw bytes behind a design-reference URL (a signed competitor skeleton URL or a
 *  data: URI). Returns null on any non-2xx / empty payload so the caller can proceed without
 *  the side-by-side (an audit artifact, not a blocker of the overlay path). Deterministic
 *  small helper — extracted so the side-by-side build path is straightforward and the retry
 *  paths in the fetch don't leak into `generateCreative`. */
async function fetchDesignReferenceBytes(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    if (!arr.byteLength) return null;
    return Buffer.from(arr);
  } catch {
    return null;
  }
}

/** Generate one static from a brief. Returns the bytes + the exact copy the caller must QA for garble. */
export async function generateCreative(workspaceId: string, brief: CreativeBrief, opts: GenerateCreativeOpts = {}): Promise<GeneratedCreative> {
  const hasRef = !!opts.designReferenceUrl;
  const aspectRatio = opts.aspectRatio ?? "4:5";
  // Only fully-qualified http(s) / data URIs — some product_media / review-image rows store a relative
  // storage path, which the Gemini fetch can't resolve. Skip those rather than fail the whole generation.
  // ⭐ CEO 2026-08-17 (#1): on a SIBLING render the canonical's finished image leads, so the
  // prompt's "the FIRST image is the finished canonical version of THIS EXACT AD" is literally true
  // and the model re-flows that ad instead of re-imagining the brief.
  const imageUrls = [
    ...(opts.canonicalRenderDataUrl ? [opts.canonicalRenderDataUrl] : []),
    ...(opts.designReferenceUrl ? [opts.designReferenceUrl] : []),
    ...brief.imageRefs.map((r) => r.url),
  ].filter((u) => typeof u === "string" && /^(https?:|data:)/.test(u));

  // ── Overlay render mode (dahlia-competitor-ad-adaptation-overlay-render Phase 1) ────────
  // Flag-gated 3-layer render path: TEXT-FREE scene from Nano Banana → font-engine copy
  // overlay via `compositeCopyOverlay`. See [[../../../docs/brain/reference/competitor-ad-adaptation]]
  // Part 2. Kept opt-in exactly like `DAHLIA_COPY_MODE`: proved-before-default against Bianca's
  // realized cold-audience CAC/CTR, never a rip-and-replace of the legacy model-draws-text
  // path. `expectedCopy` still drives the caller's QA — but on the overlay path spelling is
  // guaranteed exact by construction (a real font engine, not a diffusion model).
  if (isOverlayRenderModeEnabled()) {
    const textFreePrompt = buildTextFreeScenePrompt(brief, hasRef, opts.compositionTransfer, aspectRatio, opts.packageDimensions);
    const isImitation = !!opts.compositionTransfer && hasRef;
    const headline = isImitation ? stripCompetitorOfferArtifacts(brief.angle.hook) : brief.angle.hook;
    const trust = brief.proofStack.slice(0, 4).join(" · ");
    const expectedCopy: GeneratedCreative["expectedCopy"] = {
      headline: isImitation ? "" : headline,
      offer: brief.offer?.headline ?? null,
      trust,
    };
    const { buffer: baseBuffer } = await generateNanoBananaProCombine({
      workspaceId,
      prompt: textFreePrompt,
      imageUrls,
      aspectRatio,
    });
    const overlayCopy: OverlayCopy = {
      headline: headline || brief.productTitle,
      benefitStack: brief.supportingBenefits.slice(0, 4).join(", ") || undefined,
      payoff: trust || undefined,
      cta: brief.offer?.headline || undefined,
    };
    const { buffer, mimeType } = await compositeCopyOverlay(baseBuffer, overlayCopy, aspectRatio);

    // dahlia-competitor-ad-adaptation-overlay-render Phase 4 — the SIDE-BY-SIDE QC gate.
    // "Adapt against a live side-by-side of the competitor ad, never in isolation" (prime
    // directive from [[../../../docs/brain/reference/competitor-ad-adaptation]]). When the
    // caller supplied a `designReferenceUrl` (a signed competitor skeleton via
    // signCreativeShot), fetch it and hand a [competitor | ours] composite back to the outer
    // regen loop so the vision judge can grade energy match-or-surpass + preserved
    // psychological structure via `sideBySideGate`. A fetch failure is non-fatal — the
    // adapted render still lands; the side-by-side is an audit + gate, not a blocker of
    // the overlay path (the outer loop skips the gate when sideBySide is absent).
    let sideBySide: GeneratedCreative["sideBySide"];
    if (opts.designReferenceUrl) {
      try {
        const competitorBuffer = await fetchDesignReferenceBytes(opts.designReferenceUrl);
        if (competitorBuffer) {
          sideBySide = await buildSideBySide(competitorBuffer, buffer, { ratio: aspectRatio });
        }
      } catch (err) {
        console.warn("overlay_side_by_side_build_failed", { err: errText(err) });
      }
    }
    return { buffer, mimeType, prompt: textFreePrompt, expectedCopy, sideBySide };
  }

  const { prompt, expectedCopy } = buildPrompt(
    brief,
    hasRef,
    opts.treatment,
    opts.compositionTransfer,
    opts.ceoReviseReason,
    opts.sourceWireframe,
    aspectRatio,
    !!opts.canonicalRenderDataUrl,
    opts.packageDimensions,
  );
  // Render-side no-competitor-leak deterministic guard (Phase 1) — after the strip
  // helper scrubbed the imitation headline AND the NO COMPETITOR OFFER hard rule was
  // negative-prompted into the composed prompt, a lingering freebie artifact token in
  // the prompt string means the strip layer has a gap and the model would still be
  // seeded with a competitor's promotional graphic language. Refuse to hand the prompt
  // to Nano Banana and let the retry loop take another attempt; the sentinel error
  // rides the existing `qa_or_gen_failed` regen path in `creative-agent.ts`.
  if (opts.compositionTransfer && renderPromptHasCompetitorOffer(prompt)) {
    throw new RenderPromptCompetitorOfferError(prompt);
  }
  const { buffer, mimeType } = await generateNanoBananaProCombine({
    workspaceId,
    prompt,
    imageUrls,
    aspectRatio,
  });
  return { buffer, mimeType, prompt, expectedCopy };
}
