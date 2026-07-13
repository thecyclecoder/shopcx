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
  searchAds,
  fetchCreative,
  isWinner,
  winnerScore,
  type NormalizedAd,
  type Seed,
} from "@/lib/adlibrary";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

export interface CreativeSkeleton {
  format: string | null;
  framework: string | null;
  hook: string | null;
  mechanism_claim: string | null;
  proof: string | null;
  offer: string | null;
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
  "offer": the offer/CTA (discount, subscribe & save, free shipping, trial) or null
}
Keep each slot concise (a phrase, not a paragraph). Use null for a slot that is genuinely absent.`;

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
      max_tokens: 1024,
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
      max_tokens: 1024,
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
    return {
      format: str(o.format),
      framework: str(o.framework),
      hook: str(o.hook),
      mechanism_claim: str(o.mechanism_claim),
      proof: str(o.proof),
      offer: str(o.offer),
    };
  } catch {
    return null;
  }
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

/**
 * Search ONE seed and ingest its long-runners into creative_skeletons.
 * Statics are visioned now (status='analyzed'); videos are routed aside
 * (status='video_pending') for the heavier Phase 6 pipeline. Dedup by `ad_key`.
 */
export async function sweepSeed(
  workspaceId: string,
  seed: Seed,
  opts: {
    minDays?: number;
    minImpressions?: number;
    minSpend?: number;
    /** Max STATICS to vision this seed (bounds Opus spend). Ranked by winnerScore — keeps the best. */
    visionCap?: number;
    /** Max VIDEOS to capture as metadata (video_pending; deconstructed later by the video pipeline). */
    videoCap?: number;
    daysBack?: number;
    pageSize?: number;
  } = {},
): Promise<IngestResult> {
  const admin = createAdminClient();
  const result = EMPTY_RESULT();

  const ads = await searchAds({
    keyword: seed.keyword,
    daysBack: opts.daysBack ?? 30,
    pageSize: opts.pageSize ?? 30,
  });
  result.searched = ads.length;

  // Freshness ledger — best-effort. Phase 2's filterSeedsByFreshness reads this table
  // to skip seeds searched within the window; here we just stamp the fact of the search.
  // A write failure MUST NOT fail the sweep (this is telemetry, not the load path).
  try {
    const { error: freshnessErr } = await admin
      .from("adlibrary_searches")
      .upsert(
        {
          workspace_id: workspaceId,
          keyword: seed.keyword,
          last_searched_at: new Date().toISOString(),
          last_result_count: ads.length,
        },
        { onConflict: "workspace_id,keyword" },
      );
    if (freshnessErr) {
      console.error(`[creative-finder] adlibrary_searches upsert error for ${seed.keyword}:`, freshnessErr.message);
    }
  } catch (err) {
    console.error(`[creative-finder] adlibrary_searches upsert threw for ${seed.keyword}:`, err);
  }

  // Winner signal = reach/spend OR longevity (not longevity alone). See adlibrary.isWinner.
  const winners = ads.filter((a) =>
    a.ad_key && isWinner(a, { minDays: opts.minDays, minImpressions: opts.minImpressions, minSpend: opts.minSpend }),
  );
  result.longRunners = winners.length; // (field name kept for back-compat; now = winner count)
  if (!winners.length) return result;

  // Dedup: which ad_keys do we already have for this workspace+source?
  const keys = winners.map((a) => a.ad_key);
  const { data: existing } = await admin
    .from("creative_skeletons")
    .select("dedup_key")
    .eq("workspace_id", workspaceId)
    .eq("source", "adlibrary")
    .in("dedup_key", keys);
  const seen = new Set((existing || []).map((r) => r.dedup_key as string));

  const fresh = winners.filter((a) => !seen.has(a.ad_key));
  result.skippedExisting = winners.length - fresh.length;

  // Rank by winner score, then cap statics (vision cost) and videos (metadata) independently — always
  // keeping the highest-signal creatives, not whatever order the API returned.
  const ranked = [...fresh].sort((a, b) => winnerScore(b) - winnerScore(a));
  const statics = ranked.filter((a) => a.media_type === "static").slice(0, opts.visionCap ?? 12);
  const videos = ranked.filter((a) => a.media_type === "video").slice(0, opts.videoCap ?? 40);

  for (const ad of [...statics, ...videos]) {
    try {
      await ingestAd(workspaceId, ad, seed);
      if (ad.media_type === "video") result.videos++;
      else result.inserted++;
    } catch (err) {
      console.error(`[creative-finder] ingest failed for ${ad.ad_key}:`, err);
      result.failed++;
    }
  }
  return result;
}

/** Vision-deconstruct (statics) and persist one ad as a creative_skeletons row. */
export async function ingestAd(workspaceId: string, ad: NormalizedAd, seed: Seed): Promise<void> {
  const admin = createAdminClient();

  let skeleton: CreativeSkeleton | null = null;
  let status: string = ad.media_type === "video" ? "video_pending" : "analyzed";
  let visionedAt: string | null = null;
  let thumbPath: string | null = null;

  if (ad.media_type === "static" && ad.creative_url) {
    try {
      const { buffer, contentType } = await fetchCreative(ad.creative_url);
      // Host our own downscaled copy so the dashboard serves it (never live-proxies the full-res
      // source — that 502'd). Best-effort: a failed upload must not fail the vision/ingest.
      try {
        await ensureCreativeShotsBucket();
        const display = await toDisplayImage(buffer);
        thumbPath = await uploadCreativeShot(`${workspaceId}/${ad.ad_key}.jpg`, display);
      } catch (e) {
        console.error(`[creative-finder] thumb upload failed for ${ad.ad_key}:`, e);
      }
      skeleton = await visionDeconstruct(workspaceId, buffer, contentType);
      visionedAt = new Date().toISOString();
      if (!skeleton) status = "failed";
    } catch (err) {
      console.error(`[creative-finder] vision failed for ${ad.ad_key}:`, err);
      status = "failed";
    }
  }

  const row = {
    workspace_id: workspaceId,
    source: "adlibrary",
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
    status,
    raw: ad.raw,
    visioned_at: visionedAt,
    updated_at: new Date().toISOString(),
  };

  // Idempotent on (workspace_id, source, dedup_key).
  const { error } = await admin
    .from("creative_skeletons")
    .upsert(row, { onConflict: "workspace_id,source,dedup_key" });
  if (error) throw new Error(error.message);
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
