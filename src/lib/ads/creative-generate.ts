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
}

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

function buildPrompt(brief: CreativeBrief, hasDesignRef: boolean, treatment?: GenerateCreativeOpts["treatment"], compositionTransfer?: boolean): { prompt: string; expectedCopy: GeneratedCreative["expectedCopy"] } {
  // For a COMPOSITION-TRANSFER (competitor imitation), the angle.hook is the COMPETITOR's proven hook —
  // it may carry THEIR brand/product name (e.g. "MUD\WTR Mushroom Tea Blend - Up to 43% Off"). Rendering
  // it verbatim over OUR packshot is a brand mismatch the QC gate correctly rejects (2026-07-13). So for
  // an imitation we DON'T lock the exact competitor string as the headline — we tell the model to echo the
  // hook's STRUCTURE while naming ONLY our product, and QC verifies OUR product name renders (ungarbled)
  // instead of demanding the competitor string. A normal (own-brand) angle keeps render-exact behavior.
  const isImitation = !!compositionTransfer && hasDesignRef;
  const headline = brief.angle.hook;
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

  // HEADLINE clause — imitation vs own-brand (see isImitation note above).
  const headlineClause = isImitation
    ? `HEADLINE: the proven competitor angle to ECHO is "${headline}". Write OUR headline in the SAME structure/energy, but it must name ONLY ${brief.productTitle} and reference ONLY our product — REMOVE any competitor brand name, product name, or trademark (never render another brand's name anywhere). Big, bold, correctly spelled, 1–2 key phrases highlighted in a color block.`
    : `HEADLINE (render EXACTLY, correct spelling, no dropped/repeated words): "${headline}" — big, bold, with 1–2 key phrases highlighted in a color block.`;

  // When the brief has NO transformation, the model must NOT free-associate a weight-loss before/after —
  // it did exactly that on 2 of 4 competitor imitations (2026-07-13), a fabricated result the QC gate then
  // (correctly) rejected. Forbid it explicitly so the render doesn't waste a generation on an auto-reject.
  const noTransformationRule = brief.transformation
    ? ""
    : ` This ad has NO transformation: do NOT render any before/after, weight-loss, body-comparison, results-timeline, or "BEFORE"/"AFTER" imagery, panel, or caption of ANY kind — no implied physical-result story.`;

  const prompt = `Design a 4:5 static ad for ${brief.productTitle}. ${refClause}${treatmentClause}

${headlineClause}

${bodyBits.join("\n")}

Show the real product (from the provided product image) prominently.

PRODUCT FIDELITY: reproduce the product package faithfully from the provided product image — its real wordmark, colors, and imagery. Keep ONLY the main brand wordmark and product name crisp and legible. For the small ingredient icons, supplement-facts panel, and any other fine print on the package: do NOT try to spell them out — a redrawn pack turns them into gibberish. Render those areas as a clean, softly-defocused, or subtly out-of-focus surface (as a real product photo's fine print looks at ad size), NOT as invented lettering. EVERY piece of text that IS legible anywhere in the image must be real, correctly-spelled English words — never gibberish, fake-latin, scrambled glyphs, or nonsense characters.

TRUST BAR (small, along the bottom, render exactly): ${trust}

OFFER (show ONCE — a single badge, never duplicated): ${offerHeadline ? `one pill/badge reading "${offerHeadline}".` : "none."}${priceLine && brief.offer?.perServing ? ` Next to it, the per-serving value "${priceLine}".` : priceLine && brief.offer?.strikethrough ? ` If a price is shown, ONLY as strikethrough MSRP → discounted: "${priceLine}" with the small disclaimer "${brief.offer?.disclaimer}".` : ""}

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
  const { prompt, expectedCopy } = buildPrompt(brief, hasRef, opts.treatment, opts.compositionTransfer);
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
