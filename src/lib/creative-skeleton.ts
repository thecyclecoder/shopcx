/**
 * Creative-skeleton deconstruction + pattern matrix — winning-static-creative-finder
 * Phases 3 + 4.
 *
 * Phase 3 (vision): for each long-running static creative, fetch the image (Bearer
 * key, via adlibrary.ts), run Claude vision, and extract the four-slot SKELETON
 * { format, framework, hook, mechanism_claim, proof, offer } into creative_skeletons.
 * The AdLibrary `body` copy is thin/empty — the real structure lives in the image,
 * so vision is mandatory. Dedup by `ad_key` so we never re-vision/re-spend.
 *
 * Phase 4 (pattern matrix — the deliverable): aggregate skeletons → slot patterns
 * that repeat across ≥N INDEPENDENT brands, and emit a ranked hook × mechanism ×
 * proof × offer test matrix. Independent-brand repetition is the score — never a
 * single ad's metrics. This is what feeds variant-generation.
 *
 * Safety: we reverse-engineer STRUCTURE + keep a link to the creative for analysis.
 * We never re-host or republish a competitor's asset. The dashboard displays the
 * creative through an authenticated proxy ([[../app/api/ads/creative-finder/media]]).
 *
 * See docs/brain/specs/winning-static-creative-finder.md.
 */
import sharp from "sharp";
import { createAdminClient } from "@/lib/supabase/admin";
import { OPUS_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";
import {
  isWinner,
  winnerScore,
  adMatchesCompetitor,
  isTransientRenderError,
  COMPETITOR_AD_SOURCE,
  COMPETITOR_AD_SOURCES,
  type NormalizedAd,
  type Seed,
} from "@/lib/competitor-ad-types";
import { collectAdsByPage, isRetryableGraphError } from "@/lib/meta-ad-library";
import { resolveAdvertiser } from "@/lib/meta-ad-library-resolve";
import { normalizeBrand } from "@/lib/competitors";
import { errText } from "@/lib/error-text";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

export interface CreativeSkeleton {
  format: string | null;
  framework: string | null;
  hook: string | null;
  mechanism_claim: string | null;
  proof: string | null;
  offer: string | null;
  /** winners-flow Phase 2c — the strategic concept rubric OUR vision emits so LANE-B (domain-search) ads
   *  carry the SAME shape as LANE-A's AdLibrary tags. `{ angle, archetype, why_it_works, cialdini_lever,
   *  awareness_stage }` — the axes Max grades Dahlia on. `format` here mirrors AdLibrary's `static_image`. */
  concept_tags: ConceptTags | null;
  /** v3 agnostic wireframe (skeleton-agnostic-wireframe-redesign): array of scaffold elements
   *  {zone, role, prominence}. This is the STRUCTURAL wireframe the M4 decision engine's reuse
   *  verdict + substitution reads — `computeReuseVerdict` in [[./creative-skeleton-reuse]] and
   *  `SkeletonForDecision.elements` in [[./ads/decision-engine]]. Shape gated at DB by the
   *  `creative_skeletons_elements_shape_trigger` (migration 20261130120001). Nullable — the
   *  legacy 4-slot substance columns still carry the raw phrases; the wireframe is additive. */
  elements: SkeletonElement[] | null;
  /** How the product is shown in the creative — vision-emitted tags. Free-form array, but Claude
   *  is prompted with the canonical tag set: packshot | lifestyle | founder | none. Empty array
   *  when vision omits it (the DB default is also `{}`). */
  product_presentation: string[];
  /** Copy cadence tags — vision-emitted. Canonical set: short_line | pattern_interrupt | number
   *  | contrast. Empty array when vision omits it (DB default is `{}`). */
  punchiness: string[];
}

/** One wireframe element — mirror of the shape gated by `creative_skeletons_elements_shape_trigger`
 *  (migration 20261130120001) and consumed by [[./creative-skeleton-reuse]] `computeReuseVerdict` +
 *  [[./ads/decision-engine]] `SkeletonForDecision.elements`. */
export interface SkeletonElement {
  zone: "header" | "hero" | "body" | "footer" | "cta";
  role: "hook" | "mechanism" | "proof" | "offer" | "risk_reversal" | "social_proof" | "price";
  prominence: number;
}

/** Zone whitelist (kept in sync with the DB trigger + the decision engine's SkeletonElement). */
export const SKELETON_ZONES = ["header", "hero", "body", "footer", "cta"] as const;
/** Role whitelist (kept in sync with the DB trigger + the decision engine's SkeletonElement). */
export const SKELETON_ROLES = [
  "hook",
  "mechanism",
  "proof",
  "offer",
  "risk_reversal",
  "social_proof",
  "price",
] as const;
/** Canonical product_presentation tag set — vision is prompted with these; unknown tags are
 *  dropped by the parser (kept vs `text[]`-in-DB so an off-vocab hallucination never lands). */
export const PRODUCT_PRESENTATION_TAGS = ["packshot", "lifestyle", "founder", "none"] as const;
/** Canonical punchiness tag set — same tag-vocabulary contract as product_presentation. */
export const PUNCHINESS_TAGS = ["short_line", "pattern_interrupt", "number", "contrast"] as const;

type ZoneT = (typeof SKELETON_ZONES)[number];
type RoleT = (typeof SKELETON_ROLES)[number];

/** The unified strategic breakdown (both lanes). LANE A fills it from AdLibrary; LANE B + backfill from OUR
 *  vision. Keys mirror `WinnerConcept['tags']` in [[./adlibrary-winners]] so Dahlia + Max read one schema. */
export interface ConceptTags {
  /** The core marketing angle (e.g. "clean energy without the crash"). */
  angle: string | null;
  /** Creative archetype (e.g. "founder-story", "problem-agitate-solve", "us-vs-them", "transformation"). */
  archetype: string | null;
  /** Why it stops the scroll + converts — the psychological read. */
  why_it_works: string | null;
  /** Dominant Cialdini lever: reciprocity | commitment | social_proof | authority | liking | scarcity | unity. */
  cialdini_lever: string | null;
  /** Schwartz awareness stage the ad targets: unaware | problem_aware | solution_aware | product_aware | most_aware. */
  awareness_stage: string | null;
  /** Media format — always "static_image" for our image-only library (mirrors AdLibrary's tag). */
  format: string | null;
}

// AdLibrary serves full-res source creatives (routinely 6-22MB) with an unreliable HTTP content-type
// (reports jpeg for png bytes). Raw bytes break two consumers: Anthropic vision hard-rejects images
// >10MB (base64) and downsamples anything over ~1568px anyway; and a 22MB buffered proxy response
// exceeds the serverless response-size limit (502). So we sharp-downscale + re-encode JPEG for each
// use — guaranteeing a supported media_type AND small bytes. See scripts/_raw-vision-fixed.ts.
async function downscaleImage(buffer: Buffer, maxEdge: number, quality: number): Promise<Buffer> {
  return sharp(buffer)
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
}

// Vision: 1568px is Anthropic's optimal (they downsample above it) — small + token-efficient.
const normalizeForVision = (buffer: Buffer) => downscaleImage(buffer, 1568, 82);
// Display/stored copy: kept HIGH-QUALITY so an operator can zoom in AND a future vision pass reads it
// well (2048px > vision's 1568 need). ~0.5-1MB, served from our own storage (no serverless limit).
const toDisplayImage = (buffer: Buffer) => downscaleImage(buffer, 2048, 88);

// The private bucket holding OUR downscaled copy of each analyzed creative. The dashboard serves a
// signed URL to this instead of live-proxying AdLibrary (which 502'd on the full-res fetch). Mirrors
// the landing-page-scout `lander-shots` bucket. We never re-host publicly — private + signed reads.
export const CREATIVE_SHOTS_BUCKET = "creative-shots";
const CREATIVE_SHOT_TTL_SEC = 60 * 60; // 1h signed reads (the list route re-signs per request)

export async function ensureCreativeShotsBucket(): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.storage.getBucket(CREATIVE_SHOTS_BUCKET);
  if (!data) await admin.storage.createBucket(CREATIVE_SHOTS_BUCKET, { public: false });
}

export async function uploadCreativeShot(path: string, buffer: Buffer): Promise<string> {
  const admin = createAdminClient();
  const { error } = await admin.storage
    .from(CREATIVE_SHOTS_BUCKET)
    .upload(path, buffer, { contentType: "image/jpeg", upsert: true });
  if (error) throw error;
  return path;
}

export async function signCreativeShot(path: string, ttlSec = CREATIVE_SHOT_TTL_SEC): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(CREATIVE_SHOTS_BUCKET).createSignedUrl(path, ttlSec);
  if (error) return null;
  return data?.signedUrl ?? null;
}

const VISION_SYSTEM = `You are a direct-response creative strategist. You reverse-engineer the STRUCTURE of a winning paid-social ad — never to copy it, only to learn the repeatable skeleton.

Given an ad creative (image), extract its skeleton as JSON. Recognize which strategist framework it uses:
- "hook-promise-proof": opens on an attention hook, makes a promise/benefit, backs it with proof.
- "problem-pivot-payoff": names a problem, pivots to the mechanism/insight, lands the payoff.
(Use the closest of these or a clear variant.)

Return ONLY a JSON object, no prose, with these keys:
{
  "format": one of "ugc" | "studio" | "text-card" | "before_after" | "demo" | "lifestyle" | "comparison" | "listicle" | "chat-screenshot" | "other",
  "framework": "hook-promise-proof" | "problem-pivot-payoff" | a short variant label,
  "hook": the opening attention grab, verbatim or tightly paraphrased,
  "mechanism_claim": the core benefit/mechanism claim (e.g. "clean energy, no jitters"),
  "proof": the proof element (reviews, badge, before/after, clinical, founder, social count) or null,
  "offer": the offer/CTA (discount, subscribe & save, free shipping, trial) or null,
  "concept_tags": {
    "angle": the core marketing angle in a short phrase (e.g. "clean energy, no crash"),
    "archetype": the creative archetype — one of "founder-story" | "problem-agitate-solve" | "us-vs-them" | "transformation" | "myth-bust" | "social-proof-wall" | "demo-proof" | "listicle" | "testimonial" | a short variant,
    "why_it_works": one sentence on WHY this stops the scroll and converts (the psychological read),
    "cialdini_lever": the dominant persuasion lever — one of "reciprocity" | "commitment" | "social_proof" | "authority" | "liking" | "scarcity" | "unity",
    "awareness_stage": the Schwartz awareness stage this ad targets — one of "unaware" | "problem_aware" | "solution_aware" | "product_aware" | "most_aware"
  },
  "elements": REQUIRED — an array describing the ad's agnostic WIREFRAME. One entry per distinct visible element (badge, headline block, hero image, proof strip, offer stripe, CTA button, …). Each entry is an object with EXACTLY these keys:
    {
      "zone": WHERE the element sits — one of "header" | "hero" | "body" | "footer" | "cta",
      "role": WHAT the element does — one of "hook" | "mechanism" | "proof" | "offer" | "risk_reversal" | "social_proof" | "price",
      "prominence": a NUMBER in [0, 1] estimating how strongly the element competes for attention (1 = the dominant element, 0 = incidental).
    }
    Return [] only if the creative genuinely has no distinguishable structure. Never return null for "elements".
  "product_presentation": an array of tags describing HOW the product is shown. Prefer these tokens: "packshot" (front-of-pack shot), "lifestyle" (in-use / in-scene), "founder" (person holding it / talking to camera), "none" (no product visible). Use [] when none apply.
  "punchiness": an array of tags describing the COPY CADENCE. Prefer these tokens: "short_line" (staccato phrases), "pattern_interrupt" (unexpected word / visual break), "number" (a statistic / count), "contrast" (X vs Y framing). Use [] when none apply.
}
Keep each slot concise (a phrase, not a paragraph). Use null for a slot that is genuinely absent.
The "concept_tags" object is the STRATEGIC read (angle + psychology); the top-level slots are the STRUCTURAL read; the "elements" array is the AGNOSTIC WIREFRAME (zone × role × prominence) — the M4 decision engine reads it to decide reuse tightness per element. Fill all three. Never return null for concept_tags OR elements — always infer the closest read.`;

/** Run Claude vision on the creative bytes → the four-slot skeleton.
 *  `contentType` is accepted for signature compatibility but no longer trusted (AdLibrary mislabels
 *  media types); the bytes are always normalized to JPEG under the vision size limit first. */
export async function visionDeconstruct(
  workspaceId: string,
  imageBuffer: Buffer,
  _contentType?: string,
): Promise<CreativeSkeleton | null> {
  if (!ANTHROPIC_API_KEY) throw new Error("no_anthropic_key");
  let normalized: Buffer;
  try {
    normalized = await normalizeForVision(imageBuffer);
  } catch (err) {
    // A creative sharp can't decode (corrupt / non-image bytes) is not visionable.
    console.error(`[creative-finder] image normalize failed:`, err);
    return null;
  }
  const mediaType = "image/jpeg";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: OPUS_MODEL,
      max_tokens: 1536,
      system: VISION_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: normalized.toString("base64") },
            },
            { type: "text", text: "Extract this ad's skeleton as JSON." },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`vision_${res.status}`);
  const json = await res.json();
  if (json?.usage) {
    try {
      await logAiUsage({
        workspaceId,
        model: OPUS_MODEL,
        usage: json.usage,
        purpose: "creative_skeleton_vision",
        ticketId: null,
      });
    } catch {}
  }
  const text: string = (json?.content?.[0]?.text || "").trim();
  return parseSkeleton(text);
}

const VIDEO_VISION_SYSTEM = `${VISION_SYSTEM}

This is a VIDEO ad, deconstructed into ordered keyframes (densest in the first ~3 seconds, where the hook lives) plus an audio transcript. Treat the frames as a storyboard, earliest first.

For "hook" specifically: the literal first-2-seconds hook = the OPENING FRAME combined with the FIRST SPOKEN LINE of the transcript. Capture what stops the scroll in those first two seconds, not a later beat.

The transcript carries the spoken copy AdLibrary's text fields lack — use it together with the frames to fill mechanism_claim / proof / offer.`;

/**
 * Run Claude vision on a VIDEO's keyframes + audio transcript → the same four-slot
 * skeleton as statics. The hook reflects the opening frame + first spoken line (the
 * literal first-2s hook). Frames are sent earliest-first as a storyboard; the
 * transcript supplies the spoken copy AdLibrary's text fields omit.
 * See docs/brain/specs/creative-finder-video.md.
 */
export async function visionDeconstructFrames(
  workspaceId: string,
  frames: Array<{ buffer: Buffer; contentType: string }>,
  transcript: string,
): Promise<CreativeSkeleton | null> {
  if (!ANTHROPIC_API_KEY) throw new Error("no_anthropic_key");
  if (!frames.length) return null;

  // Normalize each keyframe the same way as the static path (fit 1568px + JPEG) — keeps every frame
  // well under the per-image limit and the multi-frame request small. Undecodable frames are dropped.
  const normalizedFrames: Buffer[] = [];
  for (const f of frames) {
    try {
      normalizedFrames.push(await normalizeForVision(f.buffer));
    } catch (err) {
      console.error(`[creative-finder] video keyframe normalize failed:`, err);
    }
  }
  if (!normalizedFrames.length) return null;

  const imageBlocks = normalizedFrames.map((buf, i) => [
    { type: "text", text: `Keyframe ${i + 1}:` },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: buf.toString("base64"),
      },
    },
  ]).flat();

  const transcriptText = transcript.trim()
    ? `Audio transcript (spoken copy):\n"""${transcript.trim().slice(0, 4000)}"""`
    : "Audio transcript: (none — silent or untranscribable; rely on the frames).";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: OPUS_MODEL,
      max_tokens: 1536,
      system: VIDEO_VISION_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            ...imageBlocks,
            { type: "text", text: transcriptText },
            { type: "text", text: "Extract this video ad's skeleton as JSON." },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`vision_${res.status}`);
  const json = await res.json();
  if (json?.usage) {
    try {
      await logAiUsage({
        workspaceId,
        model: OPUS_MODEL,
        usage: json.usage,
        purpose: "creative_skeleton_video_vision",
        ticketId: null,
      });
    } catch {}
  }
  const text: string = (json?.content?.[0]?.text || "").trim();
  return parseSkeleton(text);
}

function parseSkeleton(text: string): CreativeSkeleton | null {
  // The model is told to return ONLY JSON; defend against a stray fence/prefix.
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const str = (v: unknown) => {
      if (v == null) return null;
      const s = String(v).trim();
      return s && s.toLowerCase() !== "null" ? s : null;
    };
    const ct = (o.concept_tags && typeof o.concept_tags === "object") ? (o.concept_tags as Record<string, unknown>) : null;
    const conceptTags: ConceptTags | null = ct
      ? {
          angle: str(ct.angle),
          archetype: str(ct.archetype),
          why_it_works: str(ct.why_it_works),
          cialdini_lever: str(ct.cialdini_lever),
          awareness_stage: str(ct.awareness_stage),
          format: str(ct.format) ?? "static_image", // image-only library
        }
      : null;
    return {
      format: str(o.format),
      framework: str(o.framework),
      hook: str(o.hook),
      mechanism_claim: str(o.mechanism_claim),
      proof: str(o.proof),
      offer: str(o.offer),
      concept_tags: conceptTags,
      elements: parseElements(o.elements),
      product_presentation: parseTagArray(o.product_presentation, PRODUCT_PRESENTATION_TAGS),
      punchiness: parseTagArray(o.punchiness, PUNCHINESS_TAGS),
    };
  } catch {
    return null;
  }
}

/** Parse + whitelist-validate the vision-emitted `elements` array. Any element failing the
 *  zone/role/prominence shape (mirrors the DB trigger's rules) is DROPPED — a malformed
 *  entry never lands in the row (better than throwing: keep the well-formed elements). A
 *  non-array (or missing) input yields `null` so the DB column stays NULL (the legacy shape). */
function parseElements(raw: unknown): SkeletonElement[] | null {
  if (!Array.isArray(raw)) return null;
  const zoneSet = new Set<string>(SKELETON_ZONES);
  const roleSet = new Set<string>(SKELETON_ROLES);
  const out: SkeletonElement[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const zone = typeof rec.zone === "string" ? rec.zone.trim().toLowerCase() : "";
    const role = typeof rec.role === "string" ? rec.role.trim().toLowerCase() : "";
    if (!zoneSet.has(zone) || !roleSet.has(role)) continue;
    const p = typeof rec.prominence === "number" ? rec.prominence : Number(rec.prominence);
    if (!Number.isFinite(p) || p < 0 || p > 1) continue;
    out.push({ zone: zone as ZoneT, role: role as RoleT, prominence: p });
  }
  return out;
}

/** Parse a vision-emitted tag array, filtering against the canonical vocabulary. An off-vocab
 *  hallucination is DROPPED — the DB column is a bare `text[]`, and an unbounded write would
 *  leak model noise into downstream aggregations (`punchiness` powers copy-cadence rollups).
 *  A non-array (or missing) input yields `[]` (matches the DB column default of `{}`). */
function parseTagArray(raw: unknown, vocab: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set<string>(vocab);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const t = v.trim().toLowerCase();
    if (!allowed.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export interface IngestResult {
  searched: number;
  longRunners: number;
  inserted: number;
  videos: number;
  skippedExisting: number;
  failed: number;
}

const EMPTY_RESULT = (): IngestResult => ({
  searched: 0,
  longRunners: 0,
  inserted: 0,
  videos: 0,
  skippedExisting: 0,
  failed: 0,
});

function toDate(s: string | null): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Freshness-gate window: the max age (in days) of a prior AdLibrary search for a given
// seed before we search it again on the daily cron. Rounded to the ~7-day cadence of
// the AdLibrary subscription's monthly cap — see docs/brain/specs/adlibrary-search-freshness-gate.md.
// Overridable per-env via ADLIBRARY_FRESHNESS_DAYS (integer, > 0).
export const ADLIBRARY_FRESHNESS_DAYS_DEFAULT = 7;

function envFreshnessDays(): number {
  const raw = process.env.ADLIBRARY_FRESHNESS_DAYS;
  if (!raw) return ADLIBRARY_FRESHNESS_DAYS_DEFAULT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : ADLIBRARY_FRESHNESS_DAYS_DEFAULT;
}

/** Named for the same knob the env override uses — the value the cron actually reads. */
export function adlibraryFreshnessDays(): number {
  return envFreshnessDays();
}

/**
 * Freshness gate for the AdLibrary daily sweep — the Phase 2 quota governor.
 *
 * Returns only seeds whose `adlibrary_searches.last_searched_at` for (workspace, keyword)
 * is either NULL (never searched — a newly-approved competitor / whitelisted page runs
 * on the very next cron) OR older than `maxAgeDays` (default `ADLIBRARY_FRESHNESS_DAYS_DEFAULT`).
 * Seeds inside the window are dropped WITHOUT a `searchAds` call — that's the whole point
 * (the subscription has a fixed ~900-search/month cap).
 *
 * Orthogonal to the [[creative-finder]] cron's ~7s SWEEP_DELAY_MS rate throttle — that
 * bounds the 10/min RATE cap; this bounds the monthly QUOTA. Both stay on.
 *
 * The manual sweep bypasses this by passing `force=true` upstream (never calls this fn).
 *
 * Failure mode: on a DB read error we log + return ALL seeds unchanged (over-search, not
 * under-search — never let a broken ledger silently starve the sweep).
 */
export async function filterSeedsByFreshness(
  workspaceId: string,
  seeds: Seed[],
  maxAgeDays: number = adlibraryFreshnessDays(),
): Promise<{ kept: Seed[]; skipped: Seed[] }> {
  if (!seeds.length) return { kept: [], skipped: [] };
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const keywords = Array.from(new Set(seeds.map((s) => s.keyword)));
  const { data, error } = await admin
    .from("adlibrary_searches")
    .select("keyword, last_searched_at")
    .eq("workspace_id", workspaceId)
    .in("keyword", keywords);
  if (error) {
    console.error(`[creative-finder] freshness read failed for ${workspaceId} — passing all seeds:`, error.message);
    return { kept: seeds, skipped: [] };
  }
  // Fresh iff we have a row AND last_searched_at is strictly newer than the cutoff.
  const freshKeywords = new Set<string>();
  for (const row of data || []) {
    const kw = row.keyword as string | null;
    const ts = row.last_searched_at as string | null;
    if (kw && ts && ts > cutoff) freshKeywords.add(kw);
  }
  const kept: Seed[] = [];
  const skipped: Seed[] = [];
  for (const seed of seeds) {
    if (freshKeywords.has(seed.keyword)) skipped.push(seed);
    else kept.push(seed);
  }
  return { kept, skipped };
}

/** OUR persistence tier from observed longevity (winners-flow longitudinal). Not AdLibrary's opaque tier —
 *  the signal is how long WE'VE watched the competitor keep the ad live. `active=false` ⇒ they killed it. */
export function deriveWinnerTier(persistenceDays: number, active: boolean): string {
  if (!active) return "retired";
  if (persistenceDays >= 21) return "proven";
  if (persistenceDays >= 7) return "building";
  return "new";
}
const daysBetween = (aIso: string, bIso: string): number =>
  Math.max(0, Math.round((Date.parse(bIso) - Date.parse(aIso)) / 86_400_000));

/**
 * Obtain the creative bytes for one ad.
 *
 * INJECTED rather than imported because the Meta source has no fetchable media url — the bytes come
 * from rendering `ad_snapshot_url` in a real browser, which only the box can do. Keeping this a
 * parameter is what stops Playwright from reaching the Vercel bundle. The box supplies
 * `renderCreativeFetcher` ([[./meta-ad-library-render]]); Vercel supplies none and therefore never
 * ingests statics. See [[../../docs/brain/integrations/meta-ad-library.md]] § where it runs.
 */
export type CreativeFetcher = (
  ad: NormalizedAd,
) => Promise<{ buffer: Buffer; contentType: string } | null>;

/** Vision-deconstruct (statics) and persist one FRESH ad as a creative_skeletons row (its FIRST observation).
 *  Sets the longitudinal clock (our_first_seen = now, observed_sweeps = 1, still_active = true). Re-observations
 *  of an already-stored ad go through `reobserveAd` (cheap, no re-vision). The upstream's own tier/score are NOT
 *  used — our winner signal is persistence across sweeps ([[docs/brain/inngest/creative-scout]]). */
export async function ingestAd(
  workspaceId: string,
  ad: NormalizedAd,
  seed: Seed,
  fetchCreative?: CreativeFetcher,
): Promise<void> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  let skeleton: CreativeSkeleton | null = null;
  let status: string = ad.media_type === "video" ? "video_pending" : "analyzed";
  let visionedAt: string | null = null;
  let thumbPath: string | null = null;

  if (ad.media_type === "static" && ad.creative_url && fetchCreative) {
    // Split the creative fetch from the vision path: a RETRYABLE upstream failure (a Graph
    // rate-limit / 5xx, or a transient render fault) must NOT persist a
    // `creative_skeletons.status='failed'` row — that would let one transient outage permanently
    // poison a promising competitor ad (its dedup_key would then be filtered by `splitNewExisting`
    // on every future sweep). Rethrow so `collectAndTrack` counts it as an attempted per-ad failure
    // with a bounded warning, and the same ad_key stays eligible next sweep.
    //
    // A PERMANENT render failure is different and IS recorded: when Meta takes an ad down it STRIPS
    // the creative from the archive, so that snapshot renders copy + a 60px avatar forever. Those
    // get `status='failed'` so we stop spending page-loads rediscovering the same nothing.
    let creative: { buffer: Buffer; contentType: string } | null = null;
    try {
      creative = await fetchCreative(ad);
    } catch (err) {
      if (isRetryableGraphError(err) || isTransientRenderError(err)) throw err;
      console.error(`[creative-finder] creative fetch failed for ${ad.ad_key}:`, err);
      status = "failed";
    }
    if (creative) {
      try {
        // Host our own downscaled copy so the dashboard serves it (never live-proxies the full-res
        // source — that 502'd). Best-effort: a failed upload must not fail the vision/ingest.
        try {
          await ensureCreativeShotsBucket();
          const display = await toDisplayImage(creative.buffer);
          thumbPath = await uploadCreativeShot(`${workspaceId}/${ad.ad_key}.jpg`, display);
        } catch (e) {
          console.error(`[creative-finder] thumb upload failed for ${ad.ad_key}:`, e);
        }
        skeleton = await visionDeconstruct(workspaceId, creative.buffer, creative.contentType);
        visionedAt = new Date().toISOString();
        if (!skeleton) status = "failed";
      } catch (err) {
        console.error(`[creative-finder] vision failed for ${ad.ad_key}:`, err);
        status = "failed";
      }
    }
  }

  const row = {
    workspace_id: workspaceId,
    source: COMPETITOR_AD_SOURCE,
    dedup_key: ad.ad_key,
    advertiser: ad.advertiser,
    title: ad.title,
    image_url: ad.creative_url,
    thumb_path: thumbPath,
    media_type: ad.media_type,
    format: skeleton?.format ?? null,
    framework: skeleton?.framework ?? null,
    hook: skeleton?.hook ?? null,
    mechanism_claim: skeleton?.mechanism_claim ?? null,
    proof: skeleton?.proof ?? null,
    offer: skeleton?.offer ?? null,
    days_running: ad.days_count,
    heat: ad.heat,
    first_seen: toDate(ad.first_seen),
    last_seen: toDate(ad.last_seen),
    resume_advertising: ad.resume_advertising_flag,
    // Full AdLibrary payload (ad-creative-scout Phase 1): destination (landing-page-scout bridge),
    // copy, CTA, spend, engagement, channel.
    destination_domain: ad.destination_domain,
    landing_page_url: ad.landing_page_url,
    has_store_url: ad.has_store_url,
    call_to_action: ad.call_to_action,
    body: ad.body,
    message: ad.message,
    estimated_spend: ad.estimated_spend,
    all_exposure_value: ad.all_exposure_value,
    impression: ad.impression,
    like_count: ad.like_count,
    comment_count: ad.comment_count,
    share_count: ad.share_count,
    view_count: ad.view_count,
    platform: ad.platform,
    fb_merge_channel: ad.fb_merge_channel,
    ads_type: ad.ads_type,
    seed_keyword: seed.keyword,
    seed_kind: seed.kind,
    // Deliberate per-product competitor linkage (CEO 2026-07-12): the scout stamps WHICH approved
    // competitor + WHICH of our products this ad was pulled for, so imitate reads a product's own shelf.
    competitor_id: seed.competitorId ?? null,
    product_id: seed.productId ?? null,
    // winners-flow — `concept_tags` ALWAYS comes from OUR vision (both lanes) so Dahlia + Max read one
    // consistent schema. AdLibrary's own LANE-A tags were dropped: mislabeled (angle="solution_aware",
    // awareness_stage="warm" — a temperature), so mixing them into our keys broke uniformity (founder 2026-07-17).
    concept_tags: skeleton?.concept_tags ?? null,
    // v3 agnostic wireframe (skeleton-agnostic-wireframe-redesign / creative-skeleton-wireframe-extractor-
    // and-backfill-actually-built Phase 2). The M4 decision engine reads `elements` for its per-element
    // reuse verdict; `product_presentation` + `punchiness` are copy-cadence rollups. Nulls are legal on
    // `elements` (legacy shape); the tag arrays default to `{}` in the DB so an empty-array write is a
    // no-op. Shape gated at DB by `creative_skeletons_elements_shape_trigger` (migration 20261130120001).
    elements: skeleton?.elements ?? null,
    product_presentation: skeleton?.product_presentation ?? [],
    punchiness: skeleton?.punchiness ?? [],
    // LONGITUDINAL winner signal (OURS, not AdLibrary's): this is the ad's FIRST observation, so persistence
    // is 0 days and the tier is "new". Future sweeps re-observe via reobserveAd and grow winner_score.
    our_first_seen: nowIso,
    our_last_seen: nowIso,
    observed_sweeps: 1,
    still_active: true,
    winner_score: 0,
    winner_tier: "new",
    status,
    raw: ad.raw,
    visioned_at: visionedAt,
    updated_at: nowIso,
  };

  // Idempotent on (workspace_id, source, dedup_key). NOTE: an upsert here would RESET the longitudinal
  // clock (our_first_seen, observed_sweeps) — that's why the sweep only calls ingestAd for genuinely NEW
  // ads and routes re-observations through reobserveAd. The upsert stays for the rare same-run dup.
  //
  // flag-a-competitor-ad-do-not-use Phase 1 invariant: `row` MUST NOT include `do_not_use` (or
  // do_not_use_reason/by/at). PostgREST's `ON CONFLICT DO UPDATE SET` only touches columns present
  // in the object, so leaving these out preserves the CEO/Max flag when the scout re-observes the
  // same ad in the rare same-run dup path (and in the normal cross-sweep path via reobserveAd). If
  // you ADD do_not_use to `row` in a future edit, you are un-flagging every re-observed ad — do not.
  const { error } = await admin
    .from("creative_skeletons")
    .upsert(row, { onConflict: "workspace_id,source,dedup_key" });
  if (error) throw new Error(error.message);
}

/** Re-observe an ad we ALREADY have (winners-flow longitudinal): bump `our_last_seen` + `observed_sweeps`,
 *  recompute the persistence-based `winner_score`/`winner_tier`, re-activate it. NO re-vision (the skeleton +
 *  concept_tags already stand) — so re-observation is a single cheap UPDATE. Returns the new persistence days. */
export async function reobserveAd(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  dedupKey: string,
): Promise<number> {
  const nowIso = new Date().toISOString();
  const { data: existing } = await admin
    .from("creative_skeletons")
    .select("id, our_first_seen, observed_sweeps")
    .eq("workspace_id", workspaceId)
    .in("source", COMPETITOR_AD_SOURCES)
    .eq("dedup_key", dedupKey)
    .single();
  if (!existing) return 0;
  const firstSeen = (existing.our_first_seen as string) ?? nowIso;
  const persistence = daysBetween(firstSeen, nowIso);
  // flag-a-competitor-ad-do-not-use Phase 1 invariant: the SET clause below MUST NOT touch
  // `do_not_use` (or do_not_use_reason/by/at). The CEO's/Max's flag lives across the weekly
  // scout sweep — re-observing an ad is a cheap longitudinal bump, never a re-evaluation of
  // its imitation quality. Adding do_not_use to this update would silently un-flag a lame ad
  // the CEO already marked and let it back onto Dahlia's imitation shelf.
  await admin
    .from("creative_skeletons")
    .update({
      our_last_seen: nowIso,
      observed_sweeps: ((existing.observed_sweeps as number) ?? 1) + 1,
      still_active: true,
      winner_score: persistence,
      winner_tier: deriveWinnerTier(persistence, true),
      updated_at: nowIso,
    })
    .eq("id", existing.id);
  return persistence;
}

/** flag-a-competitor-ad-do-not-use Phase 2 — the ONLY writer of the `do_not_use` columns on
 *  `public.creative_skeletons`. Scope-guarded on (workspace_id, id) so the caller can't flip a
 *  row in another workspace even with a leaked skeleton id, and uses compare-and-set via
 *  `.select("id")` so exactly one row must transition — bails if zero (stale/cross-workspace
 *  read, deleted row). Passing `doNotUse=false` clears the flag AND its reason/by/at trio.
 *
 *  `by` is 'ceo' for a manual flag from the ad-library page (Phase 2), 'max' for the Phase-3
 *  imitation-quality grader's auto-flag — never a silent proxy-optimizer; a Max-flagged row is
 *  surfaced to the CEO for confirm/override. `reason` is a short slug ('ceo_manual' / 'max_weak_imitation_base')
 *  or a CEO note. The `do_not_use=false` clear path resets reason/by/at to null so the row is
 *  visibly unflagged (matches how the CEO expects the toggle to look after clicking).
 *
 *  Returns `true` when a row transitioned, `false` when the skeleton wasn't found in this
 *  workspace (the caller renders that as a 404). Throws on the raw Supabase error.
 *
 *  Consumers: the PATCH handler on [[../app/api/ads/competitors/[id]/route]] and (Phase 3)
 *  the Max imitation-quality grader. Read by [[./ads/creative-sourcing]] `queryProvenAngles`
 *  (skips `do_not_use=true` so a flagged ad never becomes an imitation angle). */
export async function setSkeletonDoNotUse(input: {
  workspaceId: string;
  skeletonId: string;
  doNotUse: boolean;
  reason?: string | null;
  by: string;
}): Promise<boolean> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const patch = input.doNotUse
    ? {
        do_not_use: true,
        do_not_use_reason: input.reason ?? null,
        do_not_use_by: input.by,
        do_not_use_at: nowIso,
        updated_at: nowIso,
      }
    : {
        // Clearing the flag ALSO clears the audit trio so the row is visibly unflagged in the
        // UI (the toggle reads `do_not_use === true`, but a stale reason/by/at is confusing to
        // the CEO and would look like "Max flagged it, then someone cleared it" on a card that
        // is actually clean).
        do_not_use: false,
        do_not_use_reason: null,
        do_not_use_by: null,
        do_not_use_at: null,
        updated_at: nowIso,
      };
  // Compare-and-set — workspace_id + id together must select exactly one row. If the read the
  // caller did was stale (row deleted, wrong workspace), .select("id") returns [] and we return
  // false so the caller renders a 404 rather than a false-positive 200. Same pattern as
  // approval-inbox.ts and setCompetitorStatus (Coaching #11/#12: never let a session-declared
  // status bypass the workspace/id guard at the write site).
  const { data, error } = await admin
    .from("creative_skeletons")
    .update(patch)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.skeletonId)
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/** Mark a competitor's ads that DIDN'T appear in this sweep as retired (winners-flow longitudinal): the
 *  competitor stopped running them → a loser signal we can trust because it's ours. Scoped to ONE competitor
 *  + lane's currently-active rows; leaves already-retired rows alone. Returns how many were retired. */
export async function markDisappearedAds(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  competitorId: string,
  seenKeys: string[],
): Promise<number> {
  const nowIso = new Date().toISOString();
  const { data: active } = await admin
    .from("creative_skeletons")
    .select("id, dedup_key")
    .eq("workspace_id", workspaceId)
    .in("source", COMPETITOR_AD_SOURCES)
    .eq("competitor_id", competitorId)
    .eq("still_active", true);
  const seen = new Set(seenKeys);
  const gone = (active || []).filter((r) => !seen.has(r.dedup_key as string)).map((r) => r.id);
  if (!gone.length) return 0;
  await admin
    .from("creative_skeletons")
    .update({ still_active: false, winner_tier: "retired", updated_at: nowIso })
    .in("id", gone);
  return gone.length;
}

// ── winners-flow — TWO-LANE competitor collection + LONGITUDINAL tracking ────
// Replaces the keyword `searchAds` stopgap (RECENT ads only, never a brand's proven long-runners). Each
// competitor routes to a lane via `resolveAdvertiser` ([[./adlibrary-winners]]):
//   • LANE A (via:'name') — a Meta pageId → `scanWinners` = the brand's FULL library (not recent-only).
//     We run OUR vision on each new static (hook/mechanism/proof/offer + concept_tags for Dahlia).
//   • LANE B (via:'domain') — advertiser un-resolvable by name but a domain is known → the brand's real
//     ads by `searchAds({ domain })`, same vision.
//   • via:null — a reliable BAD SEED (neither name nor domain resolves).
// AdLibrary's own tier/score are NOT trusted (they came back "loser" for every major brand; the composite
// just tracked a mis-parsed recency number). The winner signal is OURS + longitudinal: every sweep, a NEW
// ad is fully ingested+visioned and an ALREADY-SEEN ad is cheaply re-observed (persistence++), while an ad
// that VANISHED from the sweep is retired. An ad a competitor keeps running across our sweeps = a proven
// winner (they keep paying because it converts) — the strongest signal, fully ours.

export interface LaneResult extends IngestResult {
  /** How the competitor's Meta page id was RESOLVED — not how ads were collected. Collection is a
   *  single `search_page_ids` call regardless of lane. `name` = a page name strictly matched the
   *  brand; `domain` = its ads overwhelmingly drive to the brand's domain. */
  lane: "name" | "domain" | null;
  pageId: string | null;
  resolvedName: string | null;
  /** Longitudinal: existing ads re-observed (persistence bumped, no re-vision) + ads retired (vanished). */
  reobserved: number;
  retired: number;
  /**
   * Ads pulled by the sweep but DROPPED at the persist boundary because the ad's advertiser
   * doesn't map to an approved competitor of this product (the spec's non-mapped-leakage guard).
   * A LANE-B (domain search) sweep that returns affiliate ads driving to the competitor's
   * domain is the canonical case ("Healthy Habits" / "A Path to Better Health" on Creamer).
   */
  nonMappedDropped: number;
  /**
   * Set when the sweep's raw pull returned 0 static ads on a competitor that resolved to a lane
   * (a resolved-but-yields-0 signal — the spec's "silent per-competitor drop" fingerprint the
   * operator needs to see). No retire happens in this case (a single empty pull could be a
   * transient AdLibrary blip and must never wipe existing skeletons for the brand).
   */
  transientEmptyPull: boolean;
  /**
   * The AdLibrary path that ACTUALLY fed the ingest for this competitor:
   *   - `winners` — LANE A's `scanWinners(pageId)` returned statics (preferred).
   *   - `keyword` — LANE A's winners scan was empty; the keyword `searchAds` fallback fed the ingest.
   *   - `domain`  — LANE B's domain `searchAds` (advertiser un-resolvable by name) OR LANE A's
   *                 winners-empty + keyword-empty fallthrough that DID find ads by domain.
   *   - `null`    — no ads ingested (bad seed OR every fallback returned 0 → `transientEmptyPull`).
   *
   * Distinct from `lane` (which just records how the competitor was routed by `resolveAdvertiser`).
   * The scout logs this per competitor so the operator can see which brands rely on the fallback
   * because their winners scan is empty (spec 2026-07-19 — Obvi/NativePath/Vital Proteins).
   */
  /** Which collection path produced the ads. `page` is the only real one under Meta (the full
   *  library by page id); `domain` records that the page id itself came from the domain lane. */
  source: "page" | "domain" | null;
}

/**
 * The persist-time approved-advertiser guard.
 *
 * Every persisted skeleton MUST belong to an APPROVED competitor of the product being swept. A
 * LANE-B (domain search) pull returns every advertiser driving traffic to the competitor's domain
 * — approved brands AND their affiliates ("Healthy Habits", "A Path to Better Health") — so
 * without this guard the affiliates persist as if they were a competitor, polluting Dahlia's
 * imitate shelf. `approved` is the SET of `normalizeBrand`-handles of every approved competitor
 * for THIS product; an ad whose `normalizeBrand(advertiser)` isn't in the set is dropped and
 * counted. A null/empty advertiser drops (we cannot verify → cannot admit).
 *
 * Pure — no DB, no network. Caller passes the pre-built set (see `creative-scout.ts`).
 *
 * When `approved` is empty (no product context / no approved competitors), the guard is a no-op:
 * we keep every ad and set `dropped = 0`. The scout only ingests when a product has ≥1 approved
 * competitor, so an empty set at this seam means the caller intentionally opted out (a plain non-
 * per-product path like the retired workspace-wide sweep).
 */
export function filterAdsByApprovedAdvertisers<T extends { advertiser: string | null }>(
  ads: T[],
  approved: Set<string>,
): { kept: T[]; dropped: number } {
  if (approved.size === 0) return { kept: ads, dropped: 0 };
  const kept: T[] = [];
  let dropped = 0;
  for (const ad of ads) {
    const handle = normalizeBrand(ad.advertiser || "");
    if (handle && approved.has(handle)) kept.push(ad);
    else dropped++;
  }
  return { kept, dropped };
}

/** Which of these ad_keys do we already have? Splits a sweep's statics into NEW (ingest+vision) vs EXISTING
 *  (cheap re-observation). Shared by both lanes. */
async function splitNewExisting(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  ads: NormalizedAd[],
): Promise<{ fresh: NormalizedAd[]; existing: NormalizedAd[] }> {
  const keys = ads.map((a) => a.ad_key).filter(Boolean);
  if (!keys.length) return { fresh: [], existing: [] };
  const seen = new Set<string>();
  // Chunk the IN() so a big domain pull doesn't blow the query — 200 keys per round.
  for (let i = 0; i < keys.length; i += 200) {
    const { data } = await admin
      .from("creative_skeletons")
      .select("dedup_key")
      .eq("workspace_id", workspaceId)
      .in("source", COMPETITOR_AD_SOURCES)
      .in("dedup_key", keys.slice(i, i + 200));
    for (const r of data || []) seen.add(r.dedup_key as string);
  }
  const fresh: NormalizedAd[] = [];
  const existing: NormalizedAd[] = [];
  for (const a of ads) (a.ad_key && seen.has(a.ad_key) ? existing : fresh).push(a);
  return { fresh, existing };
}

/** The shared longitudinal core: ingest NEW statics (vision, capped), re-observe EXISTING statics (cheap),
 *  then retire this competitor's ads that DIDN'T appear this sweep. Mutates `result` counts.
 *
 *  IMPORTANT — retire semantics: `statics` here is the GUARD-PASSED set (only ads whose advertiser
 *  belongs to an approved competitor of the product). We retire ads whose competitor_id === seed.competitorId
 *  and whose dedup_key is NOT in this guard-passed pool — so a genuine LANE-B affiliate hit doesn't
 *  count as "the competitor's ad is still active" for retire purposes. */
async function collectAndTrack(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  seed: Seed,
  statics: NormalizedAd[],
  cap: number,
  result: LaneResult,
  fetchCreative?: CreativeFetcher,
): Promise<void> {
  const { fresh, existing } = await splitNewExisting(admin, workspaceId, statics);
  result.skippedExisting = existing.length;
  result.longRunners = fresh.length;

  // NEW ads → full ingest + vision, capped (Opus spend). Highest-signal first (caller pre-ranks).
  for (const ad of fresh.slice(0, cap)) {
    try {
      await ingestAd(workspaceId, ad, seed, fetchCreative);
      result.inserted++;
    } catch (err) {
      if (isRetryableGraphError(err) || isTransientRenderError(err)) {
        // Transient upstream fault (Graph rate-limit/5xx, or a flaky render) — `ingestAd` rethrew
        // BEFORE any DB write, so no poisoned failed row exists and the same ad_key stays
        // eligible for the next sweep. Log a bounded warning (not console.error) so the
        // Vercel error feed doesn't page on a routine external hiccup. Still counted as a
        // per-ad failure in the sweep totals — the sweep did attempt this ad.
        console.warn(
          `[creative-scout] retryable AdLibrary creative fetch skipped ${ad.ad_key} (${errText(err)}); no row persisted, will retry on next sweep`,
        );
        result.failed++;
        continue;
      }
      console.error(`[creative-scout] ingest failed for ${ad.ad_key}:`, err);
      result.failed++;
    }
  }
  // EXISTING ads → cheap re-observation (persistence++, no re-vision). This is what grows the winner signal.
  for (const ad of existing) {
    try {
      await reobserveAd(admin, workspaceId, ad.ad_key);
      result.reobserved++;
    } catch (err) {
      console.error(`[creative-scout] reobserve failed for ${ad.ad_key}:`, err);
    }
  }
  // VANISHED ads (this competitor's active rows not in this sweep's guard-passed pool) → retired.
  // Needs the competitor link. The caller's transient-empty defense (upstream) ensures we NEVER reach
  // this branch with an empty raw pull — so retire only fires on a real, non-empty sweep.
  if (seed.competitorId) {
    try {
      result.retired = await markDisappearedAds(
        admin,
        workspaceId,
        seed.competitorId,
        statics.map((a) => a.ad_key).filter(Boolean),
      );
    } catch (err) {
      console.error(`[creative-scout] retire-sweep failed for ${seed.keyword}:`, err);
    }
  }
}

/** Collect one competitor's STATIC creatives via the two-lane flow + longitudinal tracking. `domain` (the
 *  competitor's registrable domain) enables LANE B when the name doesn't resolve. `visionCap` bounds Opus.
 *  `approvedAdvertisers` is the set of `normalizeBrand`-handles of every APPROVED competitor for this
 *  product — the persist-time guard drops any pulled ad whose advertiser isn't in the set (spec's
 *  non-mapped-leakage fix; "Healthy Habits" / "A Path to Better Health" on Creamer). Pass `undefined`
 *  or an empty set to opt out (no guard). */
/**
 * Sweep ONE competitor's ads off the Meta Ad Library and ingest the statics.
 *
 * ── WHY THIS IS ONE CALL NOW ─────────────────────────────────────────────────────────────
 * The AdLibrary era needed a three-rung fallback ladder here — a paid `winners` scan, then a
 * keyword search, then a domain search — because no single AdLibrary endpoint reliably returned a
 * brand's real library (`/api/search` only ever returned ads first-seen in the last ~8 days, so the
 * long-runners we actually want were invisible to it).
 *
 * Meta has no such problem: `search_page_ids` returns the advertiser's FULL library with real
 * per-ad delivery dates, so longevity is MEASURED rather than bought, and one call replaces the
 * ladder. Verified live 2026-08-24 — Erth Labs returned 79 ads spanning 2026-01-29 → 07-13 with a
 * 95-day top runner.
 *
 * Lanes still exist, but only for RESOLUTION (brand → page id), not collection:
 *   • `via:'name'`   — a page name strictly matched the brand.
 *   • `via:'domain'` — no name match, but a page's ads overwhelmingly drive to the brand's domain.
 *   • `via:null`     — a reliable bad seed. We do NOT guess.
 *
 * `seed.metaPageId` short-circuits resolution entirely — `competitors.meta_page_id` is already
 * populated for most rows, and a stored id is authoritative.
 */
export async function sweepCompetitorLanes(
  workspaceId: string,
  seed: Seed,
  opts: {
    domain?: string | null;
    visionCap?: number;
    approvedAdvertisers?: Set<string>;
    /** Minimum days an ad must have been delivering to be worth visioning. Default 7. */
    minWinnerDays?: number;
    /** Supplied by the BOX. Without it statics are collected + tracked but never rendered/visioned,
     *  because obtaining Meta creative bytes needs a browser. See [[./meta-ad-library-render]]. */
    fetchCreative?: CreativeFetcher;
  } = {},
): Promise<LaneResult> {
  const admin = createAdminClient();
  const result: LaneResult = {
    ...EMPTY_RESULT(),
    lane: null,
    pageId: null,
    resolvedName: null,
    reobserved: 0,
    retired: 0,
    nonMappedDropped: 0,
    transientEmptyPull: false,
    source: null,
  };
  const cap = opts.visionCap ?? 12;
  const approved = opts.approvedAdvertisers ?? new Set<string>();

  // Prefer the stored page id; only pay for resolution when we don't have one.
  let pageId = seed.metaPageId ?? null;
  let via: "name" | "domain" | null = pageId ? "name" : null;
  if (!pageId) {
    const resolution = await resolveAdvertiser(workspaceId, seed.keyword, { domain: opts.domain });
    pageId = resolution.pageId;
    via = resolution.via;
    result.resolvedName = resolution.name;
  }
  result.pageId = pageId;
  result.lane = via;

  // Neither lane resolved — a reliable bad seed. The caller surfaces it; we don't guess a page id,
  // because a confidently-wrong one silently fills the library with another brand's creative.
  if (!pageId) return result;

  const pulled = await collectAdsByPage(workspaceId, pageId, {
    // We research statics; video routes to its own pipeline. IMAGE + MEME both count as static —
    // founder 2026-08-24 — and that distinction is load-bearing: Erth runs ZERO plain IMAGE ads, so
    // filtering on IMAGE alone would report a prolific advertiser as having no statics at all.
    staticsOnly: true,
    // Ads Meta took down have no creative to render, so they can never become a skeleton.
    excludeRemoved: true,
  });

  result.searched = pulled.length;
  if (pulled.length === 0) {
    // An empty pull could be a Graph dip or a genuinely paused advertiser. NEVER retire existing
    // skeletons on a single empty run — that would churn the library on one bad request.
    result.transientEmptyPull = true;
    return result;
  }

  // ── LONGEVITY FLOOR ──────────────────────────────────────────────────────────────────
  // Under AdLibrary this gate lived in the (paid) winners endpoint, which pre-filtered for us.
  // Collecting the FULL library ourselves means nothing filters by default, and a first live sweep
  // ingested MUD\\WTR ads that had been running 1 and 5 days — vision spend on creative that may not
  // survive the week. Meta gives REAL delivery dates, so we can gate on measured traction rather
  // than waiting to observe persistence ourselves: an ad Meta says started 96 days ago is proven on
  // the first sweep that sees it.
  const winners = pulled.filter((a) => isWinner(a, { minDays: opts.minWinnerDays }));
  if (winners.length === 0) {
    // The advertiser IS running ads, none long enough to qualify yet. Distinct from an empty pull:
    // nothing is wrong upstream, so don't flag it transient — but don't retire existing skeletons
    // either, since the competitor is clearly still active.
    console.log(
      `[creative-scout] "${seed.keyword}": ${pulled.length} static(s) pulled, 0 met the ${opts.minWinnerDays ?? 7}-day floor`,
    );
    return result;
  }

  result.source = via === "domain" ? "domain" : "page";
  const ranked = [...winners].sort((a, b) => winnerScore(b) - winnerScore(a));
  const guarded = filterAdsByApprovedAdvertisers(ranked, approved);
  result.nonMappedDropped = guarded.dropped;
  await collectAndTrack(admin, workspaceId, seed, guarded.kept, cap, result, opts.fetchCreative);
  return result;
}

// ── Phase 4 — the pattern matrix ─────────────────────────────────────────────

export type Slot = "hook" | "mechanism_claim" | "proof" | "offer";
export const SLOTS: Slot[] = ["hook", "mechanism_claim", "proof", "offer"];

interface SkeletonRow {
  advertiser: string | null;
  hook: string | null;
  mechanism_claim: string | null;
  proof: string | null;
  offer: string | null;
  days_running: number | null;
}

export interface SlotPattern {
  slot: Slot;
  /** Canonical label for the repeated pattern (e.g. "no jitters / clean energy"). */
  label: string;
  /** Distinct INDEPENDENT brands exhibiting it — this is the score. */
  brandCount: number;
  brands: string[];
  /** Max longevity among the ads exhibiting it (tiebreak / supporting signal). */
  maxDaysRunning: number;
  exampleValues: string[];
}

export interface TestMatrixRow {
  hook: string;
  mechanism_claim: string;
  proof: string;
  offer: string;
  /** Sum of the per-slot brand counts — favors combos whose slots each repeat widely. */
  score: number;
}

export interface PatternMatrix {
  generatedFrom: number; // analyzed skeleton count
  brandCount: number;
  slotPatterns: SlotPattern[];
  testMatrix: TestMatrixRow[];
}

/** Crude canonicalization: lowercase, strip punctuation, collapse whitespace. */
function canon(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Group slot values across brands and surface the patterns that repeat across
 * ≥minBrands INDEPENDENT brands. This is deterministic (token-overlap clustering)
 * so the matrix is reproducible and cheap — no per-load LLM spend.
 */
export async function buildPatternMatrix(
  workspaceId: string,
  opts: { minBrands?: number } = {},
): Promise<PatternMatrix> {
  const admin = createAdminClient();
  const minBrands = opts.minBrands ?? 2;
  const { data } = await admin
    .from("creative_skeletons")
    .select("advertiser, hook, mechanism_claim, proof, offer, days_running")
    .eq("workspace_id", workspaceId)
    .in("status", ["analyzed", "shortlisted"]);
  const rows = (data || []) as SkeletonRow[];

  const allBrands = new Set(rows.map((r) => r.advertiser).filter(Boolean) as string[]);

  const slotPatterns: SlotPattern[] = [];
  for (const slot of SLOTS) {
    slotPatterns.push(...clusterSlot(rows, slot, minBrands));
  }
  // Rank by independent-brand repetition, then longevity.
  slotPatterns.sort((a, b) => b.brandCount - a.brandCount || b.maxDaysRunning - a.maxDaysRunning);

  return {
    generatedFrom: rows.length,
    brandCount: allBrands.size,
    slotPatterns,
    testMatrix: buildTestMatrix(slotPatterns),
  };
}

/** Cluster one slot's values into patterns by greedy token-overlap. */
function clusterSlot(rows: SkeletonRow[], slot: Slot, minBrands: number): SlotPattern[] {
  interface Cluster {
    tokens: Set<string>;
    values: string[];
    brands: Set<string>;
    maxDays: number;
  }
  const clusters: Cluster[] = [];

  for (const r of rows) {
    const raw = r[slot];
    const brand = r.advertiser;
    if (!raw || !brand) continue;
    const c = canon(raw);
    if (!c) continue;
    const tokens = new Set(c.split(" ").filter((t) => t.length > 2));
    if (!tokens.size) continue;

    // Find the best-overlapping existing cluster (Jaccard ≥ 0.34).
    let best: Cluster | null = null;
    let bestScore = 0;
    for (const cl of clusters) {
      const inter = [...tokens].filter((t) => cl.tokens.has(t)).length;
      const union = new Set([...tokens, ...cl.tokens]).size;
      const j = union ? inter / union : 0;
      if (j > bestScore) {
        bestScore = j;
        best = cl;
      }
    }
    if (best && bestScore >= 0.34) {
      best.values.push(raw);
      best.brands.add(brand);
      best.maxDays = Math.max(best.maxDays, r.days_running ?? 0);
      tokens.forEach((t) => best!.tokens.add(t));
    } else {
      clusters.push({
        tokens,
        values: [raw],
        brands: new Set([brand]),
        maxDays: r.days_running ?? 0,
      });
    }
  }

  return clusters
    .filter((cl) => cl.brands.size >= minBrands)
    .map((cl) => ({
      slot,
      label: shortestValue(cl.values),
      brandCount: cl.brands.size,
      brands: [...cl.brands],
      maxDaysRunning: cl.maxDays,
      exampleValues: cl.values.slice(0, 5),
    }));
}

function shortestValue(values: string[]): string {
  return values.slice().sort((a, b) => a.length - b.length)[0] || "";
}

/**
 * Emit the cross-product test matrix: the top repeating pattern per slot combined
 * into hook × mechanism × proof × offer combos, ranked by summed cross-brand
 * repetition. This is the consumable hand-off for variant-generation.
 */
function buildTestMatrix(patterns: SlotPattern[]): TestMatrixRow[] {
  const top = (slot: Slot, n: number) =>
    patterns.filter((p) => p.slot === slot).slice(0, n);
  const hooks = top("hook", 3);
  const mechs = top("mechanism_claim", 3);
  const proofs = top("proof", 2);
  const offers = top("offer", 2);

  // If a slot has no repeating pattern, fall back to a single empty placeholder so
  // the combinatorics still produce rows for the slots that DO repeat.
  const orNone = <T extends { label: string; brandCount: number }>(arr: T[]) =>
    arr.length ? arr : ([{ label: "—", brandCount: 0 } as unknown as T]);

  const rows: TestMatrixRow[] = [];
  for (const h of orNone(hooks))
    for (const m of orNone(mechs))
      for (const p of orNone(proofs))
        for (const o of orNone(offers))
          rows.push({
            hook: h.label,
            mechanism_claim: m.label,
            proof: p.label,
            offer: o.label,
            score: h.brandCount + m.brandCount + p.brandCount + o.brandCount,
          });
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, 25);
}
