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
import { version as REMOTION_LAMBDA_PKG_VERSION } from "@remotion/lambda/package.json";

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

// ── VO-spine captions (the proven Veo pipeline) ─────────────────────────────
// The talking segments' own audio IS the voiceover. Captions are built from each
// segment's Whisper words, PROOFREAD against the script that generated the clip
// (Veo adds hallucinated filler), with numbers + "%" preserved. One caption on
// screen at a time. Mirrors what shipped in the approved Amazing Coffee ad.

const NUMWORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17",
  eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70",
  eighty: "80", ninety: "90", hundred: "100",
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ONES: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const normWord = (s: string): string => {
  let n = (s || "").toLowerCase().replace(/[^a-z0-9%]/g, "");
  if (NUMWORDS[n] !== undefined) return NUMWORDS[n];
  // Compound tens-ones (hyphen already stripped): "sixty-two" → "sixtytwo" → "62".
  for (const t in TENS) {
    if (n.startsWith(t)) {
      const rest = n.slice(t.length);
      if (rest === "") return String(TENS[t]);
      if (ONES[rest] !== undefined) return String(TENS[t] + ONES[rest]);
    }
  }
  return n;
};

/**
 * Align Whisper words to the script, then display the SCRIPT word (timed by
 * Whisper) — never Whisper's own text. This is the key correctness rule: Whisper
 * garbles/splits words ("superfoods"→"super"+"foods", drops/halves words), so
 * keeping its text loses content. Displaying the script word guarantees captions
 * show your actual copy: full "superfoods", numbers as digits ("twelve"→"12"),
 * "forty percent"→"40%". Veo filler (words not in the script) is dropped.
 */
export function proofreadWords(scriptText: string, words: TranscriptWord[]): TranscriptWord[] {
  // Parallel arrays: norm token (for matching) + display form (what shows).
  const parts = (scriptText || "")
    .split(/\s+/)
    .map((raw) => ({ raw, n: normWord(raw) }))
    .filter((p) => p.n);
  if (!parts.length) return words;
  const tokens = parts.map((p) => p.n);
  // Numbers display as digits (from NUMWORDS); other words keep their script form.
  const display = parts.map((p) => (/^\d+$/.test(p.n) ? p.n : p.raw.replace(/[",.;:!?()]/g, "")));

  const out: TranscriptWord[] = [];
  let ti = 0;
  const push = (w: TranscriptWord, k: number) => {
    const p: TranscriptWord = { ...w, word: display[k] };
    ti = k + 1;
    // "forty percent" → "40%": attach % to the number's beat, consume "percent".
    if (ti < tokens.length && (tokens[ti] === "percent" || tokens[ti] === "%")) {
      const digits = (p.word.match(/\d+/) || [])[0];
      if (digits) { p.word = digits + "%"; ti++; }
    }
    out.push(p);
  };
  const matches = (nw: string, k: number) => nw === tokens[k] || tokens[k].includes(nw) || nw.includes(tokens[k]);
  for (const w of words) {
    const nw = normWord(w.word);
    if (!nw) continue;
    if (ti >= tokens.length) break;
    if (matches(nw, ti)) { push(w, ti); continue; }
    let found = -1;
    for (let k = ti + 1; k < Math.min(ti + 3, tokens.length); k++) if (matches(nw, k)) { found = k; break; }
    if (found >= 0) push(w, found);
  }
  return out;
}

const VO_EMPHASIS = /pound|aging|wrong|free|shipping|superfood|energy|crash|forty|40|percent|%|limited|craving|shed|website|\d/i;

/** Group proofread words into 1-2 word Hormozi beats, one on screen at a time. */
export function groupVoCaptions(words: TranscriptWord[]): CaptionGroup[] {
  const groups: CaptionGroup[] = [];
  let i = 0, gi = 0;
  while (i < words.length) {
    const clean = (words[i].word || "").replace(/[^a-z0-9%]/gi, "");
    let take = clean.length <= 4 ? 1 : 2;
    const next = words[i + 1]?.word?.trim()?.toLowerCase();
    if (["up", "off", "in", "on"].includes(next || "")) take = 2;
    take = Math.min(take, words.length - i);
    const slice = words.slice(i, i + take);
    const text = slice.map((s) => s.word.trim()).join(" ").replace(/[",.]/g, "").trim();
    const emphasis = slice.some((s) => VO_EMPHASIS.test(s.word));
    const baseColor: "yellow" | "white" = Math.floor(gi / 3) % 2 === 1 ? "white" : "yellow";
    groups.push({ text, start: slice[0].start, end: slice[slice.length - 1].end, color: emphasis ? "yellow" : baseColor, emphasis });
    i += take; gi++;
  }
  // Non-overlap: each caption shows until the next one starts.
  for (let g = 0; g < groups.length - 1; g++) groups[g].end = groups[g + 1].start;
  if (groups.length) groups[groups.length - 1].end += 0.4;
  return groups;
}

/**
 * Build the global caption track for an ad from its talking segments. Each
 * segment contributes its proofread words, offset to its position on the
 * timeline (startSec). Pass the segment's own script + Whisper words.
 */
export function buildVoCaptions(
  segments: { scriptText: string | null; words: TranscriptWord[]; startSec: number }[],
): CaptionGroup[] {
  const all: TranscriptWord[] = [];
  for (const s of segments) {
    const clean = proofreadWords(s.scriptText || "", s.words);
    for (const w of clean) all.push({ ...w, start: w.start + s.startSec, end: w.end + s.startSec });
  }
  return groupVoCaptions(all);
}

// ── VO-spine video render (the proven composition) ──────────────────────────

export interface VoSpineProps {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  segments: { src: string; startSec: number; trimSec: number }[];
  broll: { src: string; fromSec: number; durSec: number; volume: number }[];
  music: { src: string; volume: number } | null;
  captions: CaptionGroup[];
}

/**
 * Render the VO-spine video (base talking segments = audio, muted/ASMR b-roll
 * overlays, low music bed, one-at-a-time Hormozi captions) via the canonical
 * ExampleAd Remotion composition. `src` values are remote signed URLs.
 */
export async function renderVoSpineVideo(props: VoSpineProps, outPath: string): Promise<{ outputPath: string }> {
  let bundler: any, renderer: any;
  try {
    bundler = await import(/* webpackIgnore: true */ "@remotion/bundler" as any);
    renderer = await import(/* webpackIgnore: true */ "@remotion/renderer" as any);
  } catch {
    throw new Error("remotion_not_installed: run `npm i remotion @remotion/bundler @remotion/renderer @remotion/cli`");
  }
  const path = await import("path");
  const entry = path.resolve(process.cwd(), "remotion/index.ts");
  const publicDir = path.resolve(process.cwd(), "remotion/public");
  const serveUrl = await bundler.bundle({ entryPoint: entry, publicDir });
  const composition = await renderer.selectComposition({ serveUrl, id: "ExampleAd", inputProps: props });
  await renderer.renderMedia({ composition, serveUrl, codec: "h264", outputLocation: outPath, inputProps: props });
  return { outputPath: outPath };
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

// ── Render dispatch: Remotion Lambda (prod) vs in-process (local dev) ────────
// REMOTION_RENDER_MODE=lambda runs the render on AWS Lambda (Vercel serverless
// can't run Remotion). Anything else uses the in-process renderer above.
// See docs/brain/integrations/remotion-lambda.md.

const RENDER_MODE = process.env.REMOTION_RENDER_MODE || "local";

function lambdaConfig() {
  const region = process.env.REMOTION_AWS_REGION || "us-east-1";
  const functionName = process.env.REMOTION_LAMBDA_FUNCTION_NAME;
  const serveUrl = process.env.REMOTION_LAMBDA_SERVE_URL;
  if (!functionName || !serveUrl) throw new Error("remotion_lambda_not_configured: set REMOTION_LAMBDA_FUNCTION_NAME + REMOTION_LAMBDA_SERVE_URL (run scripts/deploy-remotion-lambda.ts)");
  // The deployed function name carries its Remotion version as a dashed suffix
  // (`remotion-render-4-0-471-mem...`). If the locally-installed @remotion/lambda
  // version drifts past the deployed function, every render fails inside Inngest
  // with a version-mismatch error. Fail fast at startup instead — re-deploy.
  const m = functionName.match(/-(\d+)-(\d+)-(\d+)-/);
  if (m) {
    const fnVersion = `${m[1]}.${m[2]}.${m[3]}`;
    if (fnVersion !== REMOTION_LAMBDA_PKG_VERSION) {
      throw new Error(`remotion_lambda_version_mismatch: pkg=${REMOTION_LAMBDA_PKG_VERSION} function=${fnVersion} — re-run scripts/deploy-remotion-lambda.ts`);
    }
  }
  return { region, functionName, serveUrl };
}

async function downloadTo(url: string, outPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`render_output_fetch_${res.status}`);
  const fs = await import("fs/promises");
  await fs.writeFile(outPath, Buffer.from(await res.arrayBuffer()));
}

/** Render the VO-spine video on Lambda (ExampleAd) → write to outPath. */
async function renderVoSpineVideoOnLambda(props: VoSpineProps, outPath: string): Promise<void> {
  const { region, functionName, serveUrl } = lambdaConfig();
  const lambda: any = await import("@remotion/lambda/client" as any);
  const { renderId, bucketName } = await lambda.renderMediaOnLambda({
    region, functionName, serveUrl,
    composition: "ExampleAd",
    inputProps: props,
    codec: "h264",
    maxRetries: 1,
    privacy: "public",
  });
  // Poll until done. Veo-length clips render in ~1-3 min.
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const p = await lambda.getRenderProgress({ renderId, bucketName, functionName, region });
    if (p.fatalErrorEncountered) throw new Error(`lambda_render_failed: ${(p.errors?.[0]?.message || "fatal").slice(0, 160)}`);
    if (p.done) {
      if (!p.outputFile) throw new Error("lambda_render_no_output");
      await downloadTo(p.outputFile, outPath);
      return;
    }
  }
}

/** Render a still on Lambda (AdStatic) → write to outPath. */
async function renderStaticOnLambda(props: AdCompositionProps, outPath: string): Promise<void> {
  const { region, functionName, serveUrl } = lambdaConfig();
  const lambda: any = await import("@remotion/lambda/client" as any);
  const out = await lambda.renderStillOnLambda({
    region, functionName, serveUrl,
    composition: "AdStatic",
    inputProps: props,
    imageFormat: "jpeg",
    frame: 0,
    privacy: "public",
  });
  await downloadTo(out.url, outPath);
}

/** Render the VO-spine video (Lambda in prod, in-process locally) → outPath. */
export async function renderVoSpineVideoTo(props: VoSpineProps, outPath: string): Promise<void> {
  if (RENDER_MODE === "lambda") return renderVoSpineVideoOnLambda(props, outPath);
  await renderVoSpineVideo(props, outPath);
}

/** Render a static ad (Lambda in prod, in-process locally) → outPath. */
export async function renderStaticTo(props: AdCompositionProps, outPath: string): Promise<void> {
  if (RENDER_MODE === "lambda") return renderStaticOnLambda(props, outPath);
  await renderAdFormat(props, outPath);
}

// ── Generic still render (any composition id) — used by the static-ad process ─

async function renderStillCompositionOnLambda(compositionId: string, inputProps: Record<string, unknown>, outPath: string): Promise<void> {
  const { region, functionName, serveUrl } = lambdaConfig();
  const lambda: any = await import("@remotion/lambda/client" as any);
  const out = await lambda.renderStillOnLambda({ region, functionName, serveUrl, composition: compositionId, inputProps, imageFormat: "jpeg", frame: 0, privacy: "public" });
  await downloadTo(out.url, outPath);
}

async function renderStillCompositionLocal(compositionId: string, inputProps: Record<string, unknown>, outPath: string): Promise<void> {
  let bundler: any, renderer: any;
  try {
    bundler = await import(/* webpackIgnore: true */ "@remotion/bundler" as any);
    renderer = await import(/* webpackIgnore: true */ "@remotion/renderer" as any);
  } catch {
    throw new Error("remotion_not_installed");
  }
  const path = await import("path");
  const serveUrl = await bundler.bundle({ entryPoint: path.resolve(process.cwd(), "remotion/index.ts"), publicDir: path.resolve(process.cwd(), "remotion/public") });
  const composition = await renderer.selectComposition({ serveUrl, id: compositionId, inputProps });
  await renderer.renderStill({ composition, serveUrl, output: outPath, inputProps, imageFormat: "jpeg", jpegQuality: 92, frame: 0 });
}

/** Render any registered still composition by id (Lambda in prod, local in dev). */
export async function renderStillCompositionTo(compositionId: string, inputProps: Record<string, unknown>, outPath: string): Promise<void> {
  if (RENDER_MODE === "lambda") return renderStillCompositionOnLambda(compositionId, inputProps, outPath);
  await renderStillCompositionLocal(compositionId, inputProps, outPath);
}
