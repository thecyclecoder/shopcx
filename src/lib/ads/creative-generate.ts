/**
 * creative-generate — turns a fully-backed [[creative-brief]] into an actual static ad via Nano Banana Pro
 * ([[gemini]] `generateNanoBananaProCombine`). Deterministic prompt assembly from the brief's structured
 * fields — the acquisition hook leads, retention truths ride in the body, proof is real, and price appears
 * ONLY via an allowed treatment (never bare MSRP). The Ad Creative Agent (a Max-session lane) calls this,
 * then VISUALLY QAs the result (garbled text / fabrication / price) and regenerates on fail before landing
 * it in Bianca's ready-to-test bin. See [[../../../docs/brain/reference/meta-scaling-methodology]].
 */
import type { CreativeBrief } from "@/lib/ads/creative-brief";
import { generateNanoBananaProCombine, type NanoBananaAspect } from "@/lib/gemini";

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
  const scanRegion = idx >= 0 ? prompt.slice(0, idx) : prompt;
  for (const re of RENDER_COMPETITOR_OFFER_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(scanRegion)) return true;
  }
  return false;
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
}

/** ceo-feedback-render-edits-the-existing-ad-format-in-place-not-a-new-whole-pack-ad Phase 1 —
 *  header sentinel a unit test can grep for to prove the CEO note landed at the TOP of the composed
 *  prompt (Nano Banana's instruction-following weighs the earliest lines heaviest). Same-file
 *  constant so buildPrompt + tests never drift. */
export const CEO_EDIT_HEADER = "CEO EDIT (apply exactly to this format):";

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
}

export function buildPrompt(brief: CreativeBrief, hasDesignRef: boolean, treatment?: GenerateCreativeOpts["treatment"], compositionTransfer?: boolean, ceoReviseReason?: string): { prompt: string; expectedCopy: GeneratedCreative["expectedCopy"] } {
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

  const bodyBits: string[] = [];
  if (brief.transformation) {
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
    ? `HEADLINE: the proven competitor angle to ECHO is "${headline}". Write OUR headline in the SAME structure/energy, but it must name ONLY ${brief.productTitle} and reference ONLY our product — REMOVE any competitor brand name, product name, or trademark (never render another brand's name anywhere). CRITICAL: also DROP any product ATTRIBUTE or ingredient descriptor from the competitor's hook that is NOT true of ${brief.productTitle} — e.g. if the competitor angle says "protein coffee" / "keto" / "collagen" and OUR product is not that, do NOT carry the word over; describe our product by its REAL nature shown on the pack (e.g. "superfood coffee"). When the competitor's product noun differs from ours, SWAP IN OURS — never copy their attribute. Big, bold, correctly spelled, 1–2 key phrases highlighted in a color block.`
    : `HEADLINE (render EXACTLY, correct spelling, no dropped/repeated words): "${headline}" — big, bold, with 1–2 key phrases highlighted in a color block.`;

  // When the brief has NO transformation, the model must NOT free-associate a weight-loss before/after —
  // it did exactly that on 2 of 4 competitor imitations (2026-07-13), a fabricated result the QC gate then
  // (correctly) rejected. Forbid it explicitly so the render doesn't waste a generation on an auto-reject.
  const noTransformationRule = brief.transformation
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

  const prompt = `Design a 4:5 static ad for ${brief.productTitle}. ${refClause}${treatmentClause}${ceoEditClause}

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

HARD RULES: never show a bare MSRP / sticker price alone. The reviewer NAME and QUOTE must be rendered EXACTLY as given (they are real reviews) — never invent a name, alter a quote, or add a fake "verified purchase" checkmark badge.${noTransformationRule} A before/after transformation image must be PHOTOREALISTIC (a real photograph of a real person) — never a cartoon, illustration, drawing, or 3D/CGI render. Every claim must match the copy given (no new claims). Output ${"4:5"}, no watermark.`;

  // expectedCopy.headline drives the QC exact-headline check. For an imitation we deliberately let the model
  // rewrite the headline off the competitor's brand, so there is no exact string to assert — leave it BLANK,
  // which both QC paths treat as "skip the exact-match, keep textLegible strict" (a productTitle sentinel
  // wrongly rejected a fine de-branded headline "The #1 Superfood Coffee" on 2026-07-13). Own-brand angles
  // still assert their exact hook. The no-competitor-brand guard lives in the generation prompt above.
  return { prompt, expectedCopy: { headline: isImitation ? "" : headline, offer: offerHeadline, trust } };
}

/** Generate one static from a brief. Returns the bytes + the exact copy the caller must QA for garble. */
export async function generateCreative(workspaceId: string, brief: CreativeBrief, opts: GenerateCreativeOpts = {}): Promise<GeneratedCreative> {
  const hasRef = !!opts.designReferenceUrl;
  const { prompt, expectedCopy } = buildPrompt(brief, hasRef, opts.treatment, opts.compositionTransfer, opts.ceoReviseReason);
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
  // Only fully-qualified http(s) / data URIs — some product_media / review-image rows store a relative
  // storage path, which the Gemini fetch can't resolve. Skip those rather than fail the whole generation.
  const imageUrls = [
    ...(opts.designReferenceUrl ? [opts.designReferenceUrl] : []),
    ...brief.imageRefs.map((r) => r.url),
  ].filter((u) => typeof u === "string" && /^(https?:|data:)/.test(u));
  const { buffer, mimeType } = await generateNanoBananaProCombine({
    workspaceId,
    prompt,
    imageUrls,
    aspectRatio: opts.aspectRatio ?? "4:5",
  });
  return { buffer, mimeType, prompt, expectedCopy };
}
