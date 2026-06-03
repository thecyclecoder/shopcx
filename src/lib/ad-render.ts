/**
 * Ad tool — Phase 5 render orchestration.
 *
 * Two halves:
 *   1. PURE PLANNING (this file): turn a transcript + product data + angle into
 *      caption groups, a credibility row, a per-length cut plan, and per-format
 *      safe-zone-validated composition props. Fully typed + testable, no deps.
 *   2. RENDER INVOCATION: hand those props to the Remotion composition in
 *      /remotion (excluded from the app tsc; needs `npm i remotion @remotion/bundler
 *      @remotion/renderer`). Invoked via dynamic import so the app builds without
 *      the heavy renderer installed.
 *
 * The renderer is called ONCE per format (Reels MP4, Feed-4:5 MP4, Stories JPG,
 * Feed-4:5 JPG) → 4 ad_videos rows linked via format_variant_of_id.
 *
 * See docs/brain/specs/ad-tool.md Phase 5.
 */
import {
  CAPTION_SPEC,
  FORMAT_SPECS,
  safeCore,
  eligibleMotions,
  type AdFormat,
  type MediaKind,
  type CaptionStyle,
  type VibeTag,
} from "@/lib/ad-tool-config";
import type { TranscriptWord } from "@/lib/ad-transcribe";

// ── Caption grouping (1-3 words, never split a phrasal verb) ─────────────────

export interface CaptionGroup {
  text: string;
  start: number;
  end: number;
  color: "yellow" | "white";
  emphasis: boolean; // ALL-CAPS in script → larger + always yellow
}

const PHRASAL_PARTICLES = new Set(["up", "out", "in", "on", "off", "down", "over", "away", "back"]);

/** Group words into 1-3 word caption beats with the Hormozi color-flip rhythm. */
export function groupCaptions(
  words: TranscriptWord[],
  style: CaptionStyle,
  loud: boolean,
): CaptionGroup[] {
  const groups: CaptionGroup[] = [];
  const flipEvery = loud ? 2 : 4; // loud vibe flips color more aggressively
  let i = 0;
  let groupIndex = 0;
  while (i < words.length) {
    const w = words[i];
    const clean = w.word.trim();
    const len = clean.replace(/[^a-zA-Z]/g, "").length;
    // 1 word for <=4-letter words, else try to pair (and keep phrasal verbs together).
    let take = len <= 4 ? 1 : 2;
    const next = words[i + 1];
    if (next && PHRASAL_PARTICLES.has(next.word.trim().toLowerCase())) take = 2;
    take = Math.min(take, 3, words.length - i);
    const slice = words.slice(i, i + take);
    const text = slice.map((s) => s.word.trim()).join(" ");
    const isEmphasis = /^[A-Z0-9 ]+$/.test(text) && /[A-Z]/.test(text);
    const baseColor: "yellow" | "white" = style === "clean_white" ? "white" : style === "hormozi_white" ? "white" : "yellow";
    const flipped = Math.floor(groupIndex / flipEvery) % 2 === 1;
    const color: "yellow" | "white" = isEmphasis ? "yellow" : flipped ? (baseColor === "yellow" ? "white" : "yellow") : baseColor;
    groups.push({ text, start: slice[0].start, end: slice[slice.length - 1].end, color, emphasis: isEmphasis });
    i += take;
    groupIndex++;
  }
  return groups;
}

// ── Credibility row (Tier-5, always-on) ─────────────────────────────────────

export interface CredibilityInput {
  certifications: string[];
  allergen_free: string[];
  awards: string[];
  review_count: number;
  review_avg: number;
  clinical_study_count: number;
  guarantee_copy: string;
  pinned_badges: string[]; // operator's ordered default
}

export interface CredibilityRow {
  badges: string[]; // row 1 — up to 5 trust chips
  socialProof: string[]; // row 2 — review/clinical/award stats
  guarantee: string; // row 3 — urgency-aware guarantee CTA
}

/** Compose the always-on credibility stack. No hardcoded badge text. */
export function composeCredibility(input: CredibilityInput): CredibilityRow {
  const available = [...input.certifications, ...input.allergen_free];
  // Order by the operator's pinned default first, then the rest.
  const ordered: string[] = [];
  for (const pin of input.pinned_badges) {
    const match = available.find((b) => b.toLowerCase() === pin.toLowerCase());
    if (match && !ordered.includes(match)) ordered.push(match);
  }
  for (const b of available) if (!ordered.includes(b)) ordered.push(b);
  const badges = ordered.slice(0, 5).map((b) => b.toUpperCase());

  const socialProof: string[] = [];
  if (input.review_count > 0) socialProof.push(`${input.review_count.toLocaleString()}+ ${input.review_avg.toFixed(1)}★ REVIEWS`);
  if (input.clinical_study_count > 0) socialProof.push(`${input.clinical_study_count} CLINICAL STUDIES`);
  if (input.awards[0]) socialProof.push(`"${input.awards[0].toUpperCase()}"`);

  const guarantee = (input.guarantee_copy || "").toUpperCase();
  return { badges, socialProof, guarantee };
}

// ── Cut plan per length ─────────────────────────────────────────────────────

export interface CutSegment {
  kind: "talking_head" | "broll" | "cta";
  startSec: number;
  endSec: number;
  brollIndex?: number;
}

/** The canonical Reels timeline; Feed-4:5 inherits it. */
export function cutPlan(lengthSec: 15 | 30): CutSegment[] {
  if (lengthSec === 15) {
    return [
      { kind: "talking_head", startSec: 0, endSec: 3 },
      { kind: "broll", startSec: 3, endSec: 4.5, brollIndex: 0 },
      { kind: "talking_head", startSec: 4.5, endSec: 9 },
      { kind: "broll", startSec: 9, endSec: 11, brollIndex: 1 },
      { kind: "talking_head", startSec: 11, endSec: 13 },
      { kind: "cta", startSec: 13, endSec: 15, brollIndex: 2 },
    ];
  }
  return [
    { kind: "talking_head", startSec: 0, endSec: 3 },
    { kind: "broll", startSec: 3, endSec: 5, brollIndex: 0 },
    { kind: "talking_head", startSec: 5, endSec: 12 },
    { kind: "broll", startSec: 12, endSec: 15, brollIndex: 1 },
    { kind: "talking_head", startSec: 15, endSec: 22 },
    { kind: "broll", startSec: 22, endSec: 26, brollIndex: 2 },
    { kind: "cta", startSec: 26, endSec: 30, brollIndex: 3 },
  ];
}

// ── Safe-zone validation (hard pre-encode gate) ─────────────────────────────

export interface PlacedElement {
  kind: string; // caption | badge | cta | face | product
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SafeZoneResult {
  ok: boolean;
  violations: string[];
}

/** Every caption/badge/key element must land inside the format-specific safe core. */
export function validateSafeZone(elements: PlacedElement[], format: AdFormat, kind: MediaKind): SafeZoneResult {
  const core = safeCore(format, kind);
  const violations: string[] = [];
  for (const el of elements) {
    const inside = el.x >= core.x && el.y >= core.y && el.x + el.w <= core.x + core.w && el.y + el.h <= core.y + core.h;
    if (!inside) violations.push(`${el.kind} at (${el.x},${el.y},${el.w}x${el.h}) exits safe core ${JSON.stringify(core)} for ${format}/${kind}`);
  }
  return { ok: violations.length === 0, violations };
}

// ── Composition props ───────────────────────────────────────────────────────

export interface IngredientPop {
  ingredient: string;
  imageUrl: string;
  start: number;
  end: number; // word duration + 200ms tail
}

export interface AdCompositionProps {
  format: AdFormat;
  mediaKind: MediaKind;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  style: CaptionStyle;
  vibeTags: VibeTag[];
  talkingHeadSegments: string[];
  brollClips: Array<{ video_url: string; motion_id: string }>;
  captions: CaptionGroup[];
  cutPlan: CutSegment[];
  credibility: CredibilityRow;
  ingredientPops: IngredientPop[];
  safeCore: { x: number; y: number; w: number; h: number };
  captionSpec: typeof CAPTION_SPEC;
  // Static-only extras (ignored by the video composition).
  heroImageUrl?: string;
  staticHeadline?: string;
  staticTemplate?: string;
}

export interface BuildPropsArgs {
  format: AdFormat;
  mediaKind: MediaKind;
  lengthSec: 15 | 30;
  style: CaptionStyle;
  vibeTags: VibeTag[];
  transcript: TranscriptWord[];
  talkingHeadSegments: string[];
  brollClips: Array<{ video_url: string; motion_id: string }>;
  credibility: CredibilityRow;
  /** ingredient name -> media url, for word-timestamp pops */
  ingredientImages: Record<string, string>;
  fps?: number;
  // Static-only extras.
  heroImageUrl?: string;
  staticHeadline?: string;
  staticTemplate?: string;
}

/** Detect ingredient mentions in the transcript and schedule image pops. */
export function buildIngredientPops(words: TranscriptWord[], ingredientImages: Record<string, string>): IngredientPop[] {
  const pops: IngredientPop[] = [];
  const names = Object.keys(ingredientImages);
  if (!names.length) return pops;
  for (const w of words) {
    const clean = w.word.trim().toLowerCase().replace(/[^a-z]/g, "");
    for (const name of names) {
      if (name.toLowerCase().replace(/[^a-z]/g, "").includes(clean) && clean.length >= 4) {
        pops.push({ ingredient: name, imageUrl: ingredientImages[name], start: w.start, end: w.end + 0.2 });
        break;
      }
    }
  }
  return pops;
}

/** Build the fully-resolved composition props for one format. */
export function buildCompositionProps(args: BuildPropsArgs): AdCompositionProps {
  const spec = FORMAT_SPECS[args.format];
  const loud = args.vibeTags.includes("loud");
  const captions = groupCaptions(args.transcript, args.style, loud);
  const core = safeCore(args.format, args.mediaKind);
  return {
    format: args.format,
    mediaKind: args.mediaKind,
    width: spec.width,
    height: spec.height,
    fps: args.fps ?? 30,
    durationSec: args.lengthSec,
    style: args.style,
    vibeTags: args.vibeTags,
    talkingHeadSegments: args.talkingHeadSegments,
    brollClips: args.brollClips,
    captions,
    cutPlan: cutPlan(args.lengthSec),
    credibility: args.credibility,
    ingredientPops: buildIngredientPops(args.transcript, args.ingredientImages),
    safeCore: core,
    captionSpec: CAPTION_SPEC,
    heroImageUrl: args.heroImageUrl,
    staticHeadline: args.staticHeadline,
    staticTemplate: args.staticTemplate,
  };
}

// ── Render invocation (dynamic — needs Remotion installed) ──────────────────

export interface RenderOutput {
  format: AdFormat;
  mediaKind: MediaKind;
  outputPath: string; // local temp path the caller uploads to storage
}

/**
 * Render one format via Remotion. Dynamically imports the renderer so the app
 * typechecks/builds without the heavy @remotion/* packages. Throws a clear error
 * if Remotion isn't installed (wire it in the deploy that ships video render).
 */
export async function renderAdFormat(props: AdCompositionProps, outPath: string): Promise<RenderOutput> {
  let bundler: any, renderer: any;
  try {
    bundler = await import(/* webpackIgnore: true */ "@remotion/bundler" as any);
    renderer = await import(/* webpackIgnore: true */ "@remotion/renderer" as any);
  } catch {
    throw new Error("remotion_not_installed: run `npm i remotion @remotion/bundler @remotion/renderer @remotion/cli`");
  }
  const path = await import("path");
  const entry = path.resolve(process.cwd(), "remotion/index.ts");
  const bundleLocation = await bundler.bundle({ entryPoint: entry });
  const compositionId = props.mediaKind === "static" ? "AdStatic" : "AdComposition";
  const composition = await renderer.selectComposition({ serveUrl: bundleLocation, id: compositionId, inputProps: props });

  if (props.mediaKind === "static") {
    await renderer.renderStill({ composition, serveUrl: bundleLocation, output: outPath, inputProps: props, frame: 0 });
  } else {
    await renderer.renderMedia({ composition, serveUrl: bundleLocation, codec: "h264", outputLocation: outPath, inputProps: props });
  }
  return { format: props.format, mediaKind: props.mediaKind, outputPath: outPath };
}
