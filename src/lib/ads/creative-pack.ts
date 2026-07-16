/**
 * creative-pack — the shape of a finished Dahlia creative pack. A finished ad Bianca can publish
 * carries THREE placement-sized statics (feed 4:5 · stories/reels 9:16 · right-column 1:1) and
 * FOUR headlines + FOUR primary texts (Meta rotates them per placement). The 3 statics share ONE
 * conversion psychology core (only colour/layout/crop varies) — expressed here as a canonical
 * `ad_videos` row + two sibling rows pointing at it via `format_variant_of_id`.
 *
 * Pure — no DB / no LLM / no fetch. `[[creative-agent]]` consumes these to build the actual writes
 * and generation calls. Verified by `creative-pack.test.ts` (dahlia-produces-3-placement-multi-copy-
 * creative-pack Phase 2).
 *
 * See [[../../../docs/brain/specs/dahlia-produces-3-placement-multi-copy-creative-pack]] and
 * [[../../../docs/brain/tables/ad_videos]] (`format` · `format_variant_of_id`).
 */
import { META_CAPS } from "@/lib/ad-tool-config";
import type { CreativeBrief } from "@/lib/ads/creative-brief";
import { buildMetaCopy } from "@/lib/ads/creative-brief";

/** The three placement families Meta rotates. */
export type PlacementFormat = "feed_4x5" | "stories_9x16" | "reels_9x16" | "right_column_1x1";

/** Nano Banana aspect string for each placement — same concept re-rendered at the placement's real size. */
export const PLACEMENT_ASPECT = {
  feed_4x5: "4:5",
  stories_9x16: "9:16",
  reels_9x16: "9:16",
  right_column_1x1: "1:1",
} as const satisfies Record<PlacementFormat, "4:5" | "9:16" | "1:1">;

export interface PlacementPackPlan {
  /** The canonical creative row — feed 4:5 is the anchor (Meta's default feed placement). Its `id`
   *  becomes each sibling's `format_variant_of_id`, expressing the same-psychology invariant. */
  canonical: { format: "feed_4x5"; aspectRatio: "4:5" };
  /** The two sibling placement renders. Stories/reels share the 9:16 aspect (Meta's Reels + Stories
   *  placements accept the same static); right-column is the 1:1 square added by Phase 1's migration. */
  siblings: Array<{ format: "stories_9x16" | "right_column_1x1"; aspectRatio: "9:16" | "1:1" }>;
}

/**
 * The finished-pack recipe. Deterministic: every Dahlia creative renders these three placement
 * formats in this order (canonical first, then siblings), from ONE brief, so the 3 statics share
 * the concept by construction.
 */
export function placementPackPlan(): PlacementPackPlan {
  return {
    canonical: { format: "feed_4x5", aspectRatio: "4:5" },
    siblings: [
      { format: "stories_9x16", aspectRatio: "9:16" },
      { format: "right_column_1x1", aspectRatio: "1:1" },
    ],
  };
}

/** The 4-headline + 4-primary-text pack. One LF8 driver / consumer-psychology core, varied hooks —
 *  NOT a temperature spread. Every string is capped to Meta's hard limits ([[../ad-tool-config]]
 *  META_CAPS: headline ≤40 · primary_text ≤125). */
export interface MetaCopyPack {
  headlines: string[];      // exactly 4
  primaryTexts: string[];   // exactly 4
  description: string;      // ≤30 chars (offer treatment)
}

/** Minimum sizes for a "publish-ready" pack — [[../ads/creative-agent]] `readyStatusForAngle` +
 *  Phase 3's `isCreativePackComplete` gate consume this. */
export const CREATIVE_PACK_MIN = {
  placementStatics: 3,   // feed_4x5 + (stories_9x16 | reels_9x16) + right_column_1x1
  headlines: 4,
  primaryTexts: 4,
} as const;

const clip = (raw: string, n: number): string => {
  const s = (raw ?? "").trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trim().replace(/[\s.,;:!-]+$/, "");
};

/** Turn a supporting benefit into a punchy headline (drops trailing punctuation, single-line). */
const asHeadline = (s: string, n = META_CAPS.headline): string => clip(s.trim().replace(/[.!?]+$/, ""), n);

/** Pull a real proof opener from the brief (used by primary-text variants) — same source
 *  `buildMetaCopy` already uses so the pack's psychology stays anchored. */
function proofOpener(brief: CreativeBrief): string {
  if (brief.transformation?.quote) return `"${clip(brief.transformation.quote, 120)}" — ${brief.transformation.reviewer}`;
  if (brief.leadProof?.kind === "review" && brief.leadProof.text) {
    return `"${clip(brief.leadProof.text, 120)}"${brief.leadProof.attribution ? ` — ${brief.leadProof.attribution}` : ""}`;
  }
  return "";
}

/**
 * buildMetaCopyPack — deterministic 4×4 copy pack for one Dahlia creative. Reuses `buildMetaCopy`
 * for the canonical (first) headline + primary text so the psychology core is guaranteed to match
 * the image the brief already produced, then rotates the SAME grounded fields (supporting benefits,
 * proof stack, offer) into three more variations. Never fabricates: fills to 4 only from real brief
 * material; when a slot has nothing new, it repeats the last real variant (still a valid publishable
 * string, and truthful) so the pack's shape invariant holds without inventing copy.
 */
export function buildMetaCopyPack(brief: CreativeBrief): MetaCopyPack {
  const base = buildMetaCopy(brief);

  // ── Headlines: canonical (from buildMetaCopy) + 3 rotations across brief material.
  const supporting = brief.supportingBenefits.filter(Boolean);
  const proofBits = brief.proofStack.filter(Boolean);
  const productTitle = brief.productTitle.trim();

  const rawHeadlines: string[] = [base.headline];
  if (supporting[0]) rawHeadlines.push(asHeadline(`${productTitle} — ${supporting[0]}`));
  if (supporting[1]) rawHeadlines.push(asHeadline(supporting[1]));
  if (proofBits[0]) rawHeadlines.push(asHeadline(proofBits[0]));
  if (brief.transformation?.quote) rawHeadlines.push(asHeadline(brief.transformation.quote));
  if (brief.leadProof?.kind === "review" && brief.leadProof.text) rawHeadlines.push(asHeadline(brief.leadProof.text));
  if (brief.offer?.headline) rawHeadlines.push(asHeadline(brief.offer.headline));

  const headlines = distinctPack(rawHeadlines, base.headline || productTitle, CREATIVE_PACK_MIN.headlines);

  // ── Primary texts: canonical + 3 rotations of the same grounded fields, each capped to META_CAPS.
  const offerLine = brief.offer?.headline ? `${brief.offer.headline}. Shop now 👉` : "Shop now 👉";
  const opener = proofOpener(brief);
  const benefitLine = supporting.length ? `${productTitle} — ${supporting.slice(0, 2).join(", ")}.` : "";
  const proofLine = proofBits.slice(0, 3).join(" · ");

  const rawPrimary: string[] = [base.primaryText];
  if (supporting.length) rawPrimary.push(clip([benefitLine, proofLine, offerLine].filter(Boolean).join("\n\n"), META_CAPS.primary_text));
  if (opener) rawPrimary.push(clip([opener, offerLine].filter(Boolean).join("\n\n"), META_CAPS.primary_text));
  if (proofLine) rawPrimary.push(clip([`${productTitle}: ${proofLine}.`, offerLine].filter(Boolean).join("\n\n"), META_CAPS.primary_text));
  if (brief.offer?.perServing) rawPrimary.push(clip([`${brief.offer.perServing}.`, offerLine].filter(Boolean).join("\n\n"), META_CAPS.primary_text));

  const primaryTexts = distinctPack(rawPrimary, base.primaryText || offerLine, CREATIVE_PACK_MIN.primaryTexts);

  return { headlines, primaryTexts, description: base.description };
}

/** Reduce a raw list to exactly `n` non-empty, order-preserving-distinct strings; pad by repeating
 *  the tail (or `fallback`) when the brief didn't supply enough real material. */
function distinctPack(raw: string[], fallback: string, n: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of raw) {
    const t = (s ?? "").trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length === n) return out;
  }
  const pad = out[out.length - 1] || fallback.trim() || "Shop now";
  while (out.length < n) out.push(pad);
  return out;
}

// ── Insert planner — turns a rendered pack into the DB writes creative-agent will make. ──────────

/** One rendered static (bytes + mime) tagged with the placement it fills. */
export interface RenderedPlacement {
  format: PlacementFormat;
  buffer: Buffer;
  mimeType: string;
}

/** Input to `planCreativePackInserts` — the caller has already rendered the 3 placement statics
 *  from ONE brief and built the 4×4 copy pack. */
export interface CreativePackInsertsInput {
  workspaceId: string;
  campaignId: string;
  canonicalRender: RenderedPlacement;      // format === 'feed_4x5'
  siblingRenders: RenderedPlacement[];     // e.g. stories_9x16 + right_column_1x1
  copyPack: MetaCopyPack;
  archetype: string;                       // 'before_after' | 'testimonial' | ...
  generatedBy: string;                     // 'ad-creative-agent'
}

/** One row's worth of the `ad_videos` insert body — `campaign_id` links to the pack's campaign;
 *  siblings carry `format_variant_of_id` (populated after the canonical insert lands its id). */
export interface AdVideoInsertBody {
  workspace_id: string;
  campaign_id: string;
  format: PlacementFormat;
  media_kind: "static";
  status: "pending";
  meta: { archetype: string; generated_by: string };
}

/** Pack of DB writes. `siblings[].format_variant_of_id` starts unset — the caller stamps it with
 *  the canonical row's `id` after that insert returns, expressing the same-psychology invariant. */
export interface CreativePackInsertsPlan {
  canonical: AdVideoInsertBody;
  siblings: AdVideoInsertBody[];
  /** Persisted on the `product_ad_angles` row's `metadata` JSONB (backward-compat, no schema change) so
   *  the sibling publish path can read the full 4×4 pack without a new column. */
  angleMetadataCopyPack: { copy_pack: MetaCopyPack };
}

/**
 * planCreativePackInserts — pure. Emits the exact DB writes the creative-agent will make for one
 * Dahlia creative pack: one canonical ad_videos row (feed_4x5) + N sibling rows (each with the
 * placement's format) + the 4×4 copy pack persisted onto the angle's metadata JSONB.
 *
 * Enforces the pack shape at authoring time — throws when the caller's input violates the
 * spec's invariants (canonical must be feed_4x5; ≥2 siblings; each sibling's format must be
 * a real placement; the 3 statics together cover feed + (stories|reels) 9:16 + right_column_1x1;
 * copy pack ≥ CREATIVE_PACK_MIN.headlines / primaryTexts). Lets Phase 3's `isCreativePackComplete`
 * be a downstream RE-check on already-persisted rows rather than a first-line validator.
 */
export function planCreativePackInserts(input: CreativePackInsertsInput): CreativePackInsertsPlan {
  const { canonicalRender, siblingRenders, copyPack } = input;
  if (canonicalRender.format !== "feed_4x5") {
    throw new Error(`creative pack canonical must be feed_4x5 (got ${canonicalRender.format})`);
  }
  if (siblingRenders.length < CREATIVE_PACK_MIN.placementStatics - 1) {
    throw new Error(`creative pack needs ${CREATIVE_PACK_MIN.placementStatics - 1} siblings (got ${siblingRenders.length})`);
  }
  const allFormats = [canonicalRender.format, ...siblingRenders.map((s) => s.format)];
  const covers9x16 = allFormats.some((f) => f === "stories_9x16" || f === "reels_9x16");
  const coversRightColumn = allFormats.includes("right_column_1x1");
  if (!covers9x16 || !coversRightColumn) {
    throw new Error(`creative pack must cover 9:16 and right_column_1x1 (got ${allFormats.join(", ")})`);
  }
  if (copyPack.headlines.length < CREATIVE_PACK_MIN.headlines) {
    throw new Error(`creative pack needs ≥${CREATIVE_PACK_MIN.headlines} headlines (got ${copyPack.headlines.length})`);
  }
  if (copyPack.primaryTexts.length < CREATIVE_PACK_MIN.primaryTexts) {
    throw new Error(`creative pack needs ≥${CREATIVE_PACK_MIN.primaryTexts} primary texts (got ${copyPack.primaryTexts.length})`);
  }

  const row = (format: PlacementFormat): AdVideoInsertBody => ({
    workspace_id: input.workspaceId,
    campaign_id: input.campaignId,
    format,
    media_kind: "static",
    status: "pending",
    meta: { archetype: input.archetype, generated_by: input.generatedBy },
  });

  return {
    canonical: row("feed_4x5"),
    siblings: siblingRenders.map((s) => row(s.format)),
    angleMetadataCopyPack: { copy_pack: copyPack },
  };
}
