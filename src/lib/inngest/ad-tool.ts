/**
 * Ad tool — async generation pipeline (Higgsfield + Whisper + Remotion).
 *
 * One function per stage; all keyed concurrency=3 per workspace so a single
 * workspace can't monopolize Higgsfield rate limits. Every Higgsfield call is
 * logged to ad_jobs by the client wrapper for audit/replay.
 *
 *   ad-tool/hero-requested        → Nano Banana Pro holding-product shot
 *   ad-tool/talking-head-requested→ Veo 3.1 Fast clips (VO spine), per beat
 *   ad-tool/broll-requested       → ONE Veo b-roll clip (text- or image-to-video)
 *   ad-tool/music-requested       → Lyria music bed
 *   ad-tool/render-requested      → assemble creative library + Remotion, 4 formats
 *   ad-tool/segment-regenerate    → refresh/HQ-upgrade one clip, re-stitch
 *
 * Every piece persists to the creative library (ad_segments). See
 * docs/brain/inngest/ad-tool.md + docs/brain/lifecycles/ad-render.md.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  generateSoulPortrait,
  pollJobUntilDone,
  creditsToCents,
} from "@/lib/higgsfield";
import { generateNanoBananaProCombine, generateVeoVideo, generateLyriaMusic, VEO_FAST_MODEL, VEO_MODEL, LYRIA_MODEL } from "@/lib/gemini";
import { uploadFromUrl, uploadBuffer, signedUrl } from "@/lib/ad-storage";
import {
  splitScriptIntoSegments,
  createSegment,
  completeSegment,
  failSegment,
  loadActiveSegments,
  buildComposition,
  saveComposition,
  regenerateSegment,
} from "@/lib/ad-segments";
import { buildAvatarPortraitPrompt, physicalSizeCue, slugify, resolveAdToolSettings, getSceneStyle, getAvatarBrollAction, VIDEO_FORMATS, STATIC_FORMATS, FORMAT_SPECS, type AdFormat, type VibeTag, type AvatarFaceAttributes, type PhysicalDimensionsLite } from "@/lib/ad-tool-config";
import { loadAngleInputs } from "@/lib/ad-angles";
import { transcribeWords } from "@/lib/ad-transcribe";
import { composeCredibility, buildCompositionProps, buildVoCaptions, renderVoSpineVideoTo, renderStaticTo, renderStillCompositionTo } from "@/lib/ad-render";
import { loadStaticInputs, buildReviewProps, buildOfferProps, buildBenefitAuthorityProps, DEFAULT_BRAND, type StaticArchetype } from "@/lib/ad-static";
import { KILLER_ARCHETYPES, KILLER_FORMATS, loadKillerAssets, buildKillerStatic, type KillerArchetype } from "@/lib/ad-statics";
import { getMetaUserToken, uploadAdVideo, waitForVideoReady, getVideoThumbnail, uploadAdImage, createAdCreative, createDualAssetCreative, createPlacementCreative, createAd, createAdSet } from "@/lib/meta-ads";
import { resolvePlacementPublish } from "@/lib/ads/placement-publish";
import { evaluateCreativePackGate, missingCreativePackDiagnosis, MISSING_CREATIVE_PACK_REASON } from "@/lib/ads/creative-pack-gate";
import { MISSING_INSTAGRAM_IDENTITY_REASON, shouldRefuseForMissingInstagramIdentity } from "@/lib/ads/publish-instagram-identity-guard";
import type { CreativePackSnapshot } from "@/lib/ads/creative-pack";
import { escalateDiagnosisToCeo } from "@/lib/agents/platform-director";
import { recordDirectorActivity } from "@/lib/director-activity";
import { generateAdvertorialPagesForCampaign } from "@/lib/advertorial-pages";
import {
  MEDIA_BUYER_TEST_ORIGIN,
  evaluateMediaBuyerTestPublish,
  escalateMediaBuyerTestPublishRefusal,
  type CreateAdsetSpec,
} from "@/lib/media-buyer/publish-gate";

// Veo talking-head prompt: strict "say ONLY these words" to suppress Veo's
// hallucinated filler (we still proofread captions, but tighter input = cleaner).
function buildTalkingHeadPrompt(productTitle: string, script: string, sceneStyle?: string | null): string {
  const scene = getSceneStyle(sceneStyle);
  return `A person holding the ${productTitle} speaks directly to camera with warm, casual, confident UGC energy. They say ONLY these exact words and NOTHING else — no extra words, no filler, no improvisation, no repetition: "${script}" ${scene.motion}. NO background music. Do NOT add any on-screen text, captions, subtitles, or words burned into the footage.`;
}
const LYRIA_PROMPT = "Upbeat optimistic uplifting instrumental background music bed, light acoustic guitar and soft claps, warm and energetic but gentle, no vocals, loopable, 25 seconds.";

// Veo b-roll: animate a product still into a muted/ASMR cutaway. The prompt is
// TAILORED to what the still actually shows (slot/alt) — a generic "pour/sizzle"
// prompt on a macro ingredient photo produces nonsense motion. No voices, no
// music (the VO spine + Lyria bed are added in the stitch).
const NO_AUDIO_TEXT = "NO voices, NO talking, NO background music, NO on-screen text, captions, or logos.";
function buildBrollPrompt(productTitle: string, slot = "", alt = ""): string {
  const ctx = `${slot} ${alt}`.toLowerCase();
  // A cup/drink/coffee scene → the classic pour/steam ASMR.
  if (/cup|mug|drink|coffee|brew|pour|latte/.test(ctx)) {
    return `ASMR close-up b-roll: a mug of ${productTitle} with soft steam rising, a gentle slow pour and a light spoon stir/clink. Photorealistic, keep it natural — NO morphing, warping, or extra limbs. ${NO_AUDIO_TEXT}`;
  }
  // Raw ingredient macro → tiny, believable motion only (no pour/sizzle).
  if (slot.startsWith("ingredient")) {
    const ing = alt || slot.replace(/^ingredient_/, "").replace(/_/g, " ");
    return `Extreme close-up macro b-roll of ${ing}. VERY subtle motion only — a slow gentle camera push-in or rotation, faint particle/dust drift, soft natural light shift. Photorealistic, keep the object intact — NO morphing, warping, or transformation. ${NO_AUDIO_TEXT}`;
  }
  // Before/after or person/lifestyle → handheld lifestyle motion.
  if (slot === "before" || slot === "after" || slot.startsWith("lifestyle") || /person|woman|man|hand|kitchen|home|drink/.test(ctx)) {
    return `Authentic UGC lifestyle b-roll: ${alt || "a real person in a warm home/kitchen setting with " + productTitle}. Subtle natural movement with a gentle handheld camera drift, warm daylight, shallow depth of field. Photorealistic, NO morphing or warping. ${NO_AUDIO_TEXT}`;
  }
  // Fallback: gentle, safe motion.
  return `Cinematic b-roll cutaway for ${productTitle}: bring this photo to life with a subtle, believable gentle camera drift and shallow depth of field. Photorealistic, keep everything intact — NO morphing or warping. ${NO_AUDIO_TEXT}`;
}

// Avatar b-roll STILL prompt: the action frame the avatar (identity-locked) is
// shown doing, fed to the Nano Banana combine. `usesProduct` adds the product
// bag as the SECOND image; otherwise it's the avatar face alone.
function buildAvatarBrollStill(action: { still: string; usesProduct: boolean }, productTitle: string): string {
  const still = action.still.replace(/\{product\}/g, productTitle);
  const productClause = action.usesProduct
    ? " Reproduce the product packaging artwork and ALL text exactly and sharply from the second image."
    : "";
  return `Create a photorealistic vertical 9:16 UGC selfie-style photo: the person from the FIRST image ${still}. Keep her face and identity IDENTICAL to the first image.${productClause} Realistic hands with exactly five fingers, natural daylight, authentic non-stock expression. No on-screen text, no watermark.`;
}

// Resolve a stored image reference to a fetchable URL for the Gemini combine.
// Refs come in three shapes: bare bucket PATHS (avatar library since the refactor),
// our own Supabase Storage signed/public URLs (which EXPIRE → 400 if reused), and
// external URLs (e.g. Shopify CDN). For the first two we (re)sign from the path so
// the URL is always fresh; external URLs pass through.
async function toFetchableUrl(ref: string | null | undefined): Promise<string | null> {
  if (!ref) return null;
  // Our own storage URL → extract the object path and re-sign (stored token is stale).
  const m = ref.match(/\/storage\/v1\/object\/(?:sign|public)\/ad-tool\/([^?]+)/);
  if (m) return signedUrl(decodeURIComponent(m[1]));
  if (/^https?:\/\//i.test(ref)) return ref; // external URL — use as-is
  return signedUrl(ref); // bare bucket path
}

const CONCURRENCY: [{ limit: number; key: string }] = [{ limit: 3, key: "event.data.workspace_id" }];

type EventData = { workspace_id: string; campaign_id: string; video_id?: string };

// ── 0. Face candidate (Soul text2image) — async, one per face ────────────────
// Image gen exceeds the Vercel function budget, so the candidates API inserts a
// 'generating' row + fires this event; we generate, poll, upload, and flip the
// row to 'available'. The UI polls the row until it's ready.
interface FaceEventData {
  workspace_id: string;
  candidate_id: string;
  gender: string;
  age_range: string;
  health_level: string;
  ethnicity: string;
  context?: string;
  variant?: number;
}

export const adToolFaceRequested = inngest.createFunction(
  { id: "ad-tool-face-requested", retries: 2, concurrency: CONCURRENCY, triggers: [{ event: "ad-tool/face-requested" }] },
  async ({ event }) => {
    const d = event.data as FaceEventData;
    const admin = createAdminClient();
    try {
      const attrs: AvatarFaceAttributes = {
        gender: d.gender as AvatarFaceAttributes["gender"],
        ageRange: d.age_range,
        healthLevel: d.health_level as AvatarFaceAttributes["healthLevel"],
        ethnicity: d.ethnicity as AvatarFaceAttributes["ethnicity"],
      };
      const variant = d.variant ?? 0;
      const prompt = buildAvatarPortraitPrompt(attrs, d.context || "", variant);
      const gen = await generateSoulPortrait({ workspaceId: d.workspace_id, prompt, quality: "1080p", seed: 1000 + variant });
      let urls = gen.outputUrls;
      if (!urls[0]) {
        if (!gen.jobSetId) throw new Error("no_job_set");
        const res = await pollJobUntilDone(d.workspace_id, gen.jobSetId, { timeoutMs: 180000 });
        if (res.status === "nsfw") throw new Error("nsfw");
        if (res.status !== "completed" || !res.outputUrls[0]) throw new Error(`soul_${res.status}`);
        urls = res.outputUrls;
      }
      const path = `avatars/${d.workspace_id}/library/${d.candidate_id}.png`;
      await uploadFromUrl(path, urls[0], "image/png");
      await admin.from("ad_avatar_candidates").update({ storage_path: path, status: "available" }).eq("id", d.candidate_id);
      return { ok: true };
    } catch (err: any) {
      await admin.from("ad_avatar_candidates").update({ status: "failed", error: String(err?.message || err) }).eq("id", d.candidate_id);
      return { ok: false, error: String(err?.message || err) };
    }
  },
);

// ── Holding-product prompt (Nano Banana Pro combine: face + product) ─────────
// The size cue (physicalSizeCue) is injected consistently regardless of which
// output format the hero seeds — the same hero image is reused across the four
// format renders, so scaling the box against the hand true-to-life once at the
// combine step keeps the perceived size consistent everywhere. See
// docs/brain/lifecycles/ad-render.md § Phase 3 — hero for the rationale.
export function buildHoldingProductPrompt(
  productTitle: string,
  dims: PhysicalDimensionsLite | null | undefined,
  vibeTags: string[],
  sceneStyle?: string | null,
): string {
  const shape = (dims?.shape && dims.shape.trim()) || "package";
  const scene = getSceneStyle(sceneStyle);
  const sizeCue = physicalSizeCue(dims);
  let prompt = `Create a photorealistic vertical 9:16 UGC selfie-style photo: the person from the FIRST image ${scene.hero}, holding the ${shape} of ${productTitle} from the SECOND image in their hands at chest height, looking toward the camera with a warm authentic smile. Keep their face and identity IDENTICAL to the first image. Reproduce the product packaging artwork and ALL text exactly and sharply from the second image. Realistic hands with exactly five fingers.${sizeCue}`;
  if (vibeTags.includes("ugly")) prompt += " Slightly off-center phone-camera framing, oversaturated color grading.";
  if (vibeTags.includes("clinical")) prompt += " Bright clean clinical lighting, lab-counter setting.";
  return prompt;
}

// ── 1. Hero (Seedream combine: avatar face + product isolated image) ─────────
export const adToolHeroRequested = inngest.createFunction(
  { id: "ad-tool-hero-requested", retries: 2, concurrency: CONCURRENCY, triggers: [{ event: "ad-tool/hero-requested" }] },
  async ({ event, step }) => {
    const { workspace_id, campaign_id, feedback } = event.data as EventData & { feedback?: string };
    const admin = createAdminClient();

    const ctx = await step.run("load", async () => {
      const { data: c } = await admin
        .from("ad_campaigns")
        .select("id, product_id, variant_id, avatar_id, vibe_tags, scene_style, products(title)")
        .eq("id", campaign_id)
        .single();
      const { data: avatar } = await admin.from("ad_avatars").select("name, reference_image_urls").eq("id", c?.avatar_id).single();
      let isoUrl: string | null = null;
      let dims: any = null;
      if (c?.variant_id) {
        const { data: v } = await admin.from("product_variants").select("isolated_image_url, physical_dimensions").eq("id", c.variant_id).single();
        isoUrl = v?.isolated_image_url || null;
        dims = v?.physical_dimensions || null;
      }
      if (!isoUrl) {
        const { data: pv } = await admin.from("product_variants").select("isolated_image_url").eq("product_id", c?.product_id).not("isolated_image_url", "is", null).limit(1).maybeSingle();
        isoUrl = pv?.isolated_image_url || null;
      }
      if (!dims) {
        const { data: p } = await admin.from("products").select("physical_dimensions").eq("id", c?.product_id).single();
        dims = p?.physical_dimensions || null;
      }
      // Sign storage paths → fetchable URLs for the Gemini combine.
      const faceUrl = await toFetchableUrl((avatar?.reference_image_urls as string[] | null)?.[0] || null);
      isoUrl = await toFetchableUrl(isoUrl);
      return { campaign: c, faceUrl, isoUrl, dims };
    });

    if (!ctx.faceUrl) {
      await admin.from("ad_campaigns").update({ status: "failed" }).eq("id", campaign_id);
      return { ok: false, reason: "no_avatar_face" };
    }
    if (!ctx.isoUrl) {
      await admin.from("ad_campaigns").update({ status: "failed" }).eq("id", campaign_id);
      return { ok: false, reason: "no_isolated_image" };
    }

    const productTitle = (ctx.campaign as any)?.products?.title || "the product";
    let prompt = buildHoldingProductPrompt(productTitle, ctx.dims, (ctx.campaign?.vibe_tags as string[]) || [], (ctx.campaign as any)?.scene_style);
    // Operator corrections from a previous attempt (e.g. anatomy fixes).
    if (feedback) prompt += ` IMPORTANT corrections from the previous attempt — fix these: ${feedback}. Ensure hands, fingers, and arms are anatomically correct and naturally positioned.`;

    const heroUrl = await step.run("nano-banana-pro-combine", async () => {
      // Nano Banana Pro (Gemini) composes [face, product] → "holding product".
      // Synchronous — image returns inline (~10-30s), no polling. Identity-locked
      // + sharp packaging text + correct anatomy.
      const { buffer, mimeType } = await generateNanoBananaProCombine({
        workspaceId: workspace_id,
        prompt,
        imageUrls: [ctx.faceUrl!, ctx.isoUrl!],
      });
      const path = `avatars/${workspace_id}/heroes/${campaign_id}.png`;
      await uploadBuffer(path, buffer, mimeType);
      return signedUrl(path);
    });

    await admin.from("ad_campaigns").update({ hero_image_url: heroUrl }).eq("id", campaign_id);
    await step.sendEvent("hero-completed", { name: "ad-tool/hero-completed", data: { workspace_id, campaign_id } });
    return { ok: true, heroUrl };
  },
);

// ── 3. Talking head (Veo 3.1 Fast, multi-segment, persisted) ─────────────────
// NOTE: there is no separate "audio" stage. The VO is the talking-head clips'
// native Veo audio; the only added track is the Lyria music bed (in render).
// The proven stack: split the script into ~8s beats, generate each as a Veo clip
// from the holding-product hero (Veo's native audio = the VO spine). Each clip is
// a durable ad_segments row carrying the exact script that made it + its Whisper
// timing + trim point — so one beat can be refreshed and re-stitched later.
export const adToolTalkingHeadRequested = inngest.createFunction(
  { id: "ad-tool-talking-head-requested", retries: 1, concurrency: CONCURRENCY, triggers: [{ event: "ad-tool/talking-head-requested" }] },
  async ({ event, step }) => {
    const { workspace_id, campaign_id } = event.data as EventData;
    const admin = createAdminClient();
    const campaign = await step.run("load", async () => {
      const { data } = await admin.from("ad_campaigns").select("hero_image_url, script_text, length_sec, scene_style, products(title)").eq("id", campaign_id).single();
      return data;
    });
    if (!campaign?.hero_image_url) return { ok: false, reason: "missing_hero" };
    const productTitle = (campaign as any)?.products?.title || "the product";
    // Re-sign the stored hero URL (the persisted signed URL may have expired since
    // the hero was made — stale URLs make Veo's image fetch 400).
    const heroImageUrl = (await toFetchableUrl(campaign.hero_image_url)) || campaign.hero_image_url;
    const scripts = splitScriptIntoSegments(campaign.script_text || "", campaign.length_sec || 15);
    if (!scripts.length) return { ok: false, reason: "no_script" };

    // One Veo clip per beat, generated sequentially (Veo Fast has a daily cap;
    // bursting risks 429). Each persists as its own ad_segments row.
    const segs = await step.run("veo-generate-persist", async () => {
      // Fresh generation replaces any prior talking-head clips (incl. failed ones).
      await admin.from("ad_segments").update({ is_active: false }).eq("campaign_id", campaign_id).eq("kind", "talking_head");
      const out: Array<{ segId: string; ok: boolean; error?: string }> = [];
      for (let i = 0; i < scripts.length; i++) {
        const prompt = buildTalkingHeadPrompt(productTitle, scripts[i], (campaign as any)?.scene_style);
        const segId = await createSegment({ workspaceId: workspace_id, campaignId: campaign_id, kind: "talking_head", seq: i, scriptText: scripts[i], prompt, model: VEO_FAST_MODEL });
        try {
          const { buffer } = await generateVeoVideo({ workspaceId: workspace_id, prompt, imageUrl: heroImageUrl, aspectRatio: "9:16", model: VEO_FAST_MODEL, timeoutMs: 360000 });
          const path = `talking-head/${workspace_id}/${segId}.mp4`;
          await uploadBuffer(path, buffer, "video/mp4");
          // Whisper for the per-segment trim point (kill Veo's end-of-clip dead air).
          let words: any[] = [];
          try { words = (await transcribeWords(await signedUrl(path))).words; } catch { /* trim falls back to clip length */ }
          const last = words[words.length - 1];
          await completeSegment(segId, { storagePath: path, durationSec: last ? last.end : undefined, trimSec: last ? last.end + 0.15 : undefined, transcript: { words } });
          out.push({ segId, ok: true });
        } catch (err: any) {
          await failSegment(segId, String(err?.message || err));
          out.push({ segId, ok: false, error: String(err?.message || err) });
        }
      }
      return out;
    });

    await step.sendEvent("th-completed", { name: "ad-tool/talking-head-completed", data: { workspace_id, campaign_id } });
    return { ok: segs.some((s) => s.ok), segments: segs };
  },
);

// ── 4. B-roll (Veo 3.1, one clip at a time) ──────────────────────────────────
// Add ONE b-roll clip per request, in the operator's chosen mode:
//   - mode="text":  text-to-video from a description (no source image)
//   - mode="image": animate a chosen still + a guiding prompt
// Appends as the next b-roll seq (doesn't disturb existing clips). Higgsfield DoP
// was 422-ing on this account, so b-roll is Veo. Fast by default, full = HQ.
interface BrollEventData {
  workspace_id: string;
  campaign_id: string;
  mode: "text" | "image" | "avatar";
  prompt?: string;
  source_url?: string;
  model?: "fast" | "full";
  avatar_action?: string; // mode="avatar": which AVATAR_BROLL_ACTIONS preset
}

export const adToolBrollRequested = inngest.createFunction(
  { id: "ad-tool-broll-requested", retries: 1, concurrency: CONCURRENCY, triggers: [{ event: "ad-tool/broll-requested" }] },
  async ({ event, step }) => {
    const d = event.data as BrollEventData;
    const { workspace_id, campaign_id } = d;
    const mode = d.mode === "text" ? "text" : d.mode === "avatar" ? "avatar" : "image";
    const veoModel = d.model === "full" ? VEO_MODEL : VEO_FAST_MODEL;
    const admin = createAdminClient();

    const ctx = await step.run("load", async () => {
      // Avatar mode also needs the avatar face + product image to build the still.
      const { data: c } = await admin
        .from("ad_campaigns")
        .select("avatar_id, product_id, variant_id, products(title)")
        .eq("id", campaign_id)
        .single();
      // Append after the highest existing active b-roll seq.
      const { data: existing } = await admin
        .from("ad_segments")
        .select("seq")
        .eq("campaign_id", campaign_id)
        .eq("kind", "broll")
        .eq("is_active", true)
        .order("seq", { ascending: false })
        .limit(1)
        .maybeSingle();
      let faceUrl: string | null = null;
      let isoUrl: string | null = null;
      if (mode === "avatar") {
        const { data: avatar } = await admin.from("ad_avatars").select("reference_image_urls").eq("id", (c as any)?.avatar_id).single();
        faceUrl = (avatar?.reference_image_urls as string[] | null)?.[0] || null;
        if ((c as any)?.variant_id) {
          const { data: v } = await admin.from("product_variants").select("isolated_image_url").eq("id", (c as any).variant_id).single();
          isoUrl = v?.isolated_image_url || null;
        }
        if (!isoUrl) {
          const { data: pv } = await admin.from("product_variants").select("isolated_image_url").eq("product_id", (c as any)?.product_id).not("isolated_image_url", "is", null).limit(1).maybeSingle();
          isoUrl = pv?.isolated_image_url || null;
        }
        // Sign storage paths → fetchable URLs for the Gemini combine.
        faceUrl = await toFetchableUrl(faceUrl);
        isoUrl = await toFetchableUrl(isoUrl);
      }
      return { productTitle: (c as any)?.products?.title || "the product", nextSeq: (existing?.seq ?? -1) + 1, faceUrl, isoUrl };
    });

    // Avatar mode: generate the action STILL (Nano Banana combine), then animate
    // it like image mode. The still is identity-locked to the avatar's face.
    let sourceUrl = mode === "image" ? d.source_url || null : null;
    let prompt = (d.prompt || "").trim() || buildBrollPrompt(ctx.productTitle);
    if (mode === "avatar") {
      const action = getAvatarBrollAction(d.avatar_action);
      if (!action) return { ok: false, reason: "unknown_avatar_action" };
      if (!ctx.faceUrl) return { ok: false, reason: "no_avatar_face" };
      if (action.usesProduct && !ctx.isoUrl) return { ok: false, reason: "no_product_image" };
      const stillPrompt = buildAvatarBrollStill(action, ctx.productTitle);
      sourceUrl = await step.run("avatar-still-combine", async () => {
        const images = action.usesProduct ? [ctx.faceUrl!, ctx.isoUrl!] : [ctx.faceUrl!];
        const { buffer, mimeType } = await generateNanoBananaProCombine({ workspaceId: workspace_id, prompt: stillPrompt, imageUrls: images });
        const path = `broll-stills/${workspace_id}/${campaign_id}-${ctx.nextSeq}-${action.value}.png`;
        await uploadBuffer(path, buffer, mimeType);
        return signedUrl(path);
      });
      prompt = `${action.motion}. Photorealistic, keep her face and identity intact — NO morphing, warping, or extra limbs. ${NO_AUDIO_TEXT}`;
    } else if (mode === "image" && !sourceUrl) {
      return { ok: false, reason: "image_mode_needs_source" };
    }

    const result = await step.run("veo-generate-persist", async () => {
      const segId = await createSegment({ workspaceId: workspace_id, campaignId: campaign_id, kind: "broll", seq: ctx.nextSeq, model: veoModel, prompt, sourceUrl });
      try {
        const { buffer } = await generateVeoVideo({ workspaceId: workspace_id, prompt, imageUrl: sourceUrl || undefined, aspectRatio: "9:16", model: veoModel, timeoutMs: 360000 });
        const path = `broll/${workspace_id}/${segId}.mp4`;
        await uploadBuffer(path, buffer, "video/mp4");
        await completeSegment(segId, { storagePath: path });
        return { segId, ok: true };
      } catch (err: any) {
        await failSegment(segId, String(err?.message || err));
        return { segId, ok: false, error: String(err?.message || err) };
      }
    });

    await step.sendEvent("broll-completed", { name: "ad-tool/broll-completed", data: { workspace_id, campaign_id } });
    return result;
  },
);

// ── 4b. Background music (Lyria) ─────────────────────────────────────────────
// Explicit control over the music bed. Render auto-generates one if missing, but
// this lets the operator generate/regenerate it (optionally with a style prompt)
// and preview it before rendering. The new clip replaces the prior active bed
// only once it succeeds (a failed gen leaves the existing music in place).
export const adToolMusicRequested = inngest.createFunction(
  { id: "ad-tool-music-requested", retries: 1, concurrency: CONCURRENCY, triggers: [{ event: "ad-tool/music-requested" }] },
  async ({ event, step }) => {
    const { workspace_id, campaign_id } = event.data as EventData;
    const prompt = ((event.data as { prompt?: string }).prompt || "").trim() || LYRIA_PROMPT;
    const admin = createAdminClient();

    const segId = await step.run("lyria-generate", async () => {
      const id = await createSegment({ workspaceId: workspace_id, campaignId: campaign_id, kind: "music", seq: 0, model: LYRIA_MODEL, prompt });
      try {
        const { buffer, mimeType } = await generateLyriaMusic({ workspaceId: workspace_id, prompt });
        const ext = mimeType.includes("wav") ? "wav" : "mp3";
        const path = `audio/${workspace_id}/${id}.${ext}`;
        await uploadBuffer(path, buffer, mimeType);
        await completeSegment(id, { storagePath: path });
        // Retire any previous music bed now that this one succeeded.
        await admin.from("ad_segments").update({ is_active: false }).eq("campaign_id", campaign_id).eq("kind", "music").neq("id", id);
        return id;
      } catch (err: any) {
        await failSegment(id, String(err?.message || err));
        throw err;
      }
    });

    await step.sendEvent("music-completed", { name: "ad-tool/music-completed", data: { workspace_id, campaign_id } });
    return { ok: true, segId };
  },
);

// ── 5. Render (Whisper + Remotion, 4 formats) ───────────────────────────────
export const adToolRenderRequested = inngest.createFunction(
  { id: "ad-tool-render-requested", retries: 1, concurrency: CONCURRENCY, triggers: [{ event: "ad-tool/render-requested" }] },
  async ({ event, step }) => {
    const { workspace_id, campaign_id } = event.data as EventData;
    const admin = createAdminClient();

    const ctx = await step.run("load", async () => {
      const { data: c } = await admin
        .from("ad_campaigns")
        .select("id, product_id, length_sec, caption_style, vibe_tags, audio_url, hero_image_url, angle_id")
        .eq("id", campaign_id)
        .single();
      const { data: ws } = await admin.from("workspaces").select("ad_tool_settings").eq("id", workspace_id).single();
      let staticHeadline = "";
      if (c?.angle_id) {
        const { data: angle } = await admin.from("product_ad_angles").select("hook_one_liner, lead_benefit_anchor").eq("id", c.angle_id).maybeSingle();
        staticHeadline = angle?.hook_one_liner || angle?.lead_benefit_anchor || "";
      }
      const inputs = await loadAngleInputs(c!.product_id);
      // Ingredient images for word-timestamp pops.
      const { data: ingredients } = await admin.from("product_ingredients").select("name").eq("product_id", c!.product_id);
      const ingredientImages: Record<string, string> = {};
      for (const ing of ingredients || []) {
        const { data: m } = await admin
          .from("product_media")
          .select("webp_1080_url, url")
          .eq("product_id", c!.product_id)
          .eq("slot", `ingredient_${slugify(ing.name)}`)
          .limit(1)
          .maybeSingle();
        if (m) ingredientImages[ing.name] = m.webp_1080_url || m.url;
      }
      return { campaign: c, settings: resolveAdToolSettings(ws?.ad_tool_settings), inputs, ingredientImages, staticHeadline };
    });

    await admin.from("ad_campaigns").update({ status: "rendering" }).eq("id", campaign_id);

    const credibility = composeCredibility({
      certifications: ctx.inputs.credibility.certifications,
      allergen_free: ctx.inputs.credibility.allergen_free,
      awards: ctx.inputs.credibility.awards,
      review_count: ctx.inputs.credibility.review_count,
      review_avg: ctx.inputs.credibility.review_avg,
      clinical_study_count: ctx.inputs.credibility.clinical_study_count,
      guarantee_copy: ctx.inputs.guarantee_copy,
      pinned_badges: ctx.settings.pinned_badges,
    });

    // Assemble from the creative library: active talking/broll/music segments →
    // composition recipe (saved) → resolved signed URLs + proofread VO captions.
    // Music is generated here (Lyria) if the campaign doesn't have one yet.
    const assembled = await step.run("assemble", async () => {
      const { talking, broll, music } = await loadActiveSegments(campaign_id);
      if (!talking.length) return null;

      // Captions come from each talking clip's Whisper transcript. If a clip was
      // generated without one (transcription can fail at gen time), backfill it
      // here so captions + tight trims always populate — never silently empty.
      for (const s of talking) {
        if (!(s.transcript_json?.words?.length) && s.storage_path) {
          try {
            const { words } = await transcribeWords(await signedUrl(s.storage_path));
            const last = words[words.length - 1];
            const trimSec = last ? last.end + 0.15 : null;
            await admin.from("ad_segments").update({ transcript_json: { words }, duration_sec: last?.end ?? null, trim_sec: trimSec }).eq("id", s.id);
            (s as any).transcript_json = { words };
            (s as any).trim_sec = trimSec ?? s.trim_sec;
            (s as any).duration_sec = last?.end ?? s.duration_sec;
          } catch (err: any) {
            await admin.from("ad_segments").update({ error: `whisper: ${String(err?.message || err).slice(0, 200)}` }).eq("id", s.id);
          }
        }
      }

      let musicId: string | null = music?.id || null;
      let musicPath: string | null = music?.storage_path || null;
      if (!musicId) {
        const segId = await createSegment({ workspaceId: workspace_id, campaignId: campaign_id, kind: "music", seq: 0, model: LYRIA_MODEL, prompt: LYRIA_PROMPT });
        try {
          const { buffer, mimeType } = await generateLyriaMusic({ workspaceId: workspace_id, prompt: LYRIA_PROMPT });
          const ext = mimeType.includes("wav") ? "wav" : "mp3";
          const path = `audio/${workspace_id}/${segId}.${ext}`;
          await uploadBuffer(path, buffer, mimeType);
          await completeSegment(segId, { storagePath: path });
          musicId = segId; musicPath = path;
        } catch (err: any) {
          await failSegment(segId, String(err?.message || err)); // music is optional
        }
      }

      const composition = buildComposition(talking, broll, musicId ? { id: musicId } : null, 30);
      await saveComposition(campaign_id, composition);

      // Resolve each recipe entry to a signed URL.
      const thById = new Map(talking.map((s) => [s.id, s]));
      const brById = new Map(broll.map((s) => [s.id, s]));
      const segments: Array<{ src: string; startSec: number; trimSec: number }> = [];
      for (const s of composition.segments) {
        const seg = thById.get(s.segment_id);
        if (seg?.storage_path) segments.push({ src: await signedUrl(seg.storage_path), startSec: s.startSec, trimSec: s.trimSec });
      }
      const brollSrc: Array<{ src: string; fromSec: number; durSec: number; volume: number }> = [];
      for (const b of composition.broll) {
        const seg = brById.get(b.segment_id);
        if (seg?.storage_path) brollSrc.push({ src: await signedUrl(seg.storage_path), fromSec: b.fromSec, durSec: b.durSec, volume: b.volume });
      }
      const musicSrc = musicPath ? { src: await signedUrl(musicPath), volume: composition.music?.volume ?? 0.12 } : null;

      // VO captions: each talking segment's Whisper words proofread vs its script.
      const captions = buildVoCaptions(
        composition.segments.map((s) => {
          const seg = thById.get(s.segment_id);
          return { scriptText: seg?.script_text || null, words: seg?.transcript_json?.words || [], startSec: s.startSec };
        }),
      );
      const transcriptWords = captions.flatMap((c) => [{ word: c.text, start: c.start, end: c.end }]);
      return { durationSec: composition.durationSec, fps: composition.fps, segments, broll: brollSrc, music: musicSrc, captions, transcriptWords };
    });

    if (!assembled) {
      // Rendered before any talking-head exists — recoverable, not a dead end.
      // Leave the campaign in draft so the operator can generate the talking head.
      await admin.from("ad_campaigns").update({ status: "draft" }).eq("id", campaign_id);
      return { ok: false, reason: "no_talking_segments" };
    }

    const lengthSec = (ctx.campaign?.length_sec === 30 ? 30 : 15) as 15 | 30;
    const style = (ctx.campaign?.caption_style as any) || "hormozi_yellow";
    const vibeTags = (ctx.campaign?.vibe_tags as VibeTag[]) || [];

    // Render each of the 4 outputs. Sibling rows link to the first (canonical).
    const plan: Array<{ format: AdFormat; kind: "video" | "static" }> = [
      ...VIDEO_FORMATS.map((f) => ({ format: f, kind: "video" as const })),
      ...STATIC_FORMATS.map((f) => ({ format: f, kind: "static" as const })),
    ];

    const results = await step.run("render-formats", async () => {
      const out: any[] = [];
      let canonicalId: string | null = null;
      for (const p of plan) {
        const ext = p.kind === "video" ? "mp4" : "jpg";
        const row: any = {
          workspace_id,
          campaign_id,
          format: p.format,
          media_kind: p.kind,
          format_variant_of_id: canonicalId,
          caption_style: style,
          duration_sec: Math.round(assembled!.durationSec),
          status: "rendering",
          transcript_json: { words: assembled!.transcriptWords },
        };
        const { data: vrow } = await admin.from("ad_videos").insert(row).select("id").single();
        if (!canonicalId) canonicalId = vrow!.id;

        try {
          const tmp = `/tmp/ad_${campaign_id}_${p.format}_${p.kind}.${ext}`;
          if (p.kind === "video") {
            const spec = FORMAT_SPECS[p.format];
            await renderVoSpineVideoTo(
              { width: spec.width, height: spec.height, fps: assembled.fps, durationSec: assembled.durationSec, segments: assembled.segments, broll: assembled.broll, music: assembled.music, captions: assembled.captions },
              tmp,
            );
          } else {
            const props = buildCompositionProps({
              format: p.format,
              mediaKind: p.kind,
              lengthSec,
              style,
              vibeTags,
              transcript: assembled.transcriptWords,
              talkingHeadSegments: [],
              brollClips: [],
              credibility,
              ingredientImages: ctx.ingredientImages,
              heroImageUrl: (ctx.campaign as any)?.hero_image_url || undefined,
              staticHeadline: ctx.staticHeadline || undefined,
              staticTemplate: "shipping_label_brutalist",
            });
            await renderStaticTo(props, tmp);
          }
          const fs = await import("fs/promises");
          const buf = await fs.readFile(tmp);
          const storagePath = `finals/${workspace_id}/${vrow!.id}.${ext}`;
          await uploadBuffer(storagePath, buf, p.kind === "video" ? "video/mp4" : "image/jpeg");
          const url = await signedUrl(storagePath);
          await admin
            .from("ad_videos")
            .update(p.kind === "video" ? { final_mp4_url: url, status: "ready", meta: { storage_path: storagePath } } : { static_jpg_url: url, status: "ready", meta: { storage_path: storagePath } })
            .eq("id", vrow!.id);
          out.push({ format: p.format, kind: p.kind, id: vrow!.id, ok: true, url });
        } catch (err: any) {
          await admin.from("ad_videos").update({ status: "failed", meta: { error: String(err?.message || err) } }).eq("id", vrow!.id);
          out.push({ format: p.format, kind: p.kind, id: vrow!.id, ok: false, error: String(err?.message || err) });
        }
      }
      return out;
    });

    const anyReady = results.some((r: any) => r.ok);
    await admin.from("ad_campaigns").update({ status: anyReady ? "ready" : "failed" }).eq("id", campaign_id);
    // Ad + its ad-matched lander come out together: when a campaign reaches ready,
    // auto-generate the advertorial / before-after lander for its angle (idempotent
    // — upsert keyed by product_id+slug). See docs/brain/specs/advertorial-landers.md.
    if (anyReady) {
      await step.sendEvent("advertorial-page", { name: "ad-tool/advertorial-page-requested", data: { workspace_id, campaign_id } });
    }
    return { ok: anyReady, results };
  },
);

// ── 6. Segment regenerate (refresh a beat / upgrade to HQ Veo 3) ─────────────
// Regenerate ONE clip (talking_head or broll) at version+1, then re-render.
//  - talking_head: optionally with a NEW script (the re-launch "refresh the hook")
//    or the same script; image = the campaign hero.
//  - broll: re-animate its stored source still.
//  - model: "fast" (Veo 3.1 Fast, default) or "full" (Veo 3.1 — slower, higher
//    quality) so the operator can upgrade a clip that came out weak.
// Every other piece is reused from the creative library; nothing else re-burned.
interface RegenEventData {
  workspace_id: string;
  campaign_id: string;
  seq: number;
  kind?: "talking_head" | "broll";
  new_script?: string;
  model?: "fast" | "full";
  prompt?: string; // broll: custom shot description (overrides the tailored prompt)
  mode?: "image" | "text"; // broll: animate the source still vs pure text-to-video
}

export const adToolSegmentRegenerate = inngest.createFunction(
  { id: "ad-tool-segment-regenerate", retries: 1, concurrency: CONCURRENCY, triggers: [{ event: "ad-tool/segment-regenerate" }] },
  async ({ event, step }) => {
    const { workspace_id, campaign_id, seq, new_script } = event.data as RegenEventData;
    const kind = (event.data as RegenEventData).kind || "talking_head";
    const veoModel = (event.data as RegenEventData).model === "full" ? VEO_MODEL : VEO_FAST_MODEL;
    const admin = createAdminClient();

    const ctx = await step.run("load", async () => {
      const { data: c } = await admin.from("ad_campaigns").select("hero_image_url, scene_style, products(title)").eq("id", campaign_id).single();
      const { data: existing } = await admin
        .from("ad_segments")
        .select("script_text, prompt, source_url")
        .eq("campaign_id", campaign_id)
        .eq("kind", kind)
        .eq("seq", seq)
        .eq("is_active", true)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      return { hero: c?.hero_image_url || null, productTitle: (c as any)?.products?.title || "the product", sceneStyle: (c as any)?.scene_style || null, existing };
    });

    const segId = await step.run("regen-veo", async () => {
      if (kind === "broll") {
        const customPrompt = ((event.data as RegenEventData).prompt || "").trim();
        const existingSource = ctx.existing?.source_url || null;
        // mode: "image" = animate the still + guiding text; "text" = pure
        // text-to-video from the description. Default to whatever it was.
        const mode = (event.data as RegenEventData).mode || (existingSource ? "image" : "text");
        const prompt = customPrompt || ctx.existing?.prompt || buildBrollPrompt(ctx.productTitle);
        if (mode === "image" && !existingSource) throw new Error("broll_no_source");
        const sourceUrl = mode === "image" ? existingSource : null;
        const id = await regenerateSegment({ workspaceId: workspace_id, campaignId: campaign_id, kind: "broll", seq, prompt, model: veoModel, sourceUrl });
        try {
          // Re-sign the stored still URL — it's a signed URL that has likely expired.
          const veoImage = sourceUrl ? (await toFetchableUrl(sourceUrl)) || undefined : undefined;
          const { buffer } = await generateVeoVideo({ workspaceId: workspace_id, prompt, imageUrl: veoImage, aspectRatio: "9:16", model: veoModel, timeoutMs: 360000 });
          const path = `broll/${workspace_id}/${id}.mp4`;
          await uploadBuffer(path, buffer, "video/mp4");
          await completeSegment(id, { storagePath: path });
          return id;
        } catch (err: any) {
          await failSegment(id, String(err?.message || err));
          throw err;
        }
      }
      // talking_head
      if (!ctx.hero) throw new Error("missing_hero");
      const script = (new_script || ctx.existing?.script_text || "").trim();
      if (!script) throw new Error("no_script");
      const prompt = buildTalkingHeadPrompt(ctx.productTitle, script, ctx.sceneStyle);
      const id = await regenerateSegment({ workspaceId: workspace_id, campaignId: campaign_id, kind: "talking_head", seq, scriptText: script, prompt, model: veoModel });
      try {
        // Re-sign the stored hero URL — the persisted signed URL likely expired.
        const heroUrl = (await toFetchableUrl(ctx.hero)) || ctx.hero;
        const { buffer } = await generateVeoVideo({ workspaceId: workspace_id, prompt, imageUrl: heroUrl, aspectRatio: "9:16", model: veoModel, timeoutMs: 360000 });
        const path = `talking-head/${workspace_id}/${id}.mp4`;
        await uploadBuffer(path, buffer, "video/mp4");
        let words: any[] = [];
        try { words = (await transcribeWords(await signedUrl(path))).words; } catch { /* trim falls back */ }
        const last = words[words.length - 1];
        await completeSegment(id, { storagePath: path, durationSec: last ? last.end : undefined, trimSec: last ? last.end + 0.15 : undefined, transcript: { words } });
        return id;
      } catch (err: any) {
        await failSegment(id, String(err?.message || err));
        throw err;
      }
    });

    // Re-stitch: re-render from the (now-updated) creative library.
    await step.sendEvent("re-render", { name: "ad-tool/render-requested", data: { workspace_id, campaign_id } });
    return { ok: true, segId };
  },
);

// ── 7. Static ads (a separate, design-led process) ──────────────────────────
// One archetype → designed Remotion still → 3 formats (1:1 / 4:5 / 9:16). No
// talking head / b-roll / timeline. Populated from product intelligence.
const STATIC_DIMS: Array<{ format: string; w: number; h: number }> = [
  { format: "feed_1x1", w: 1080, h: 1080 },
  { format: "feed_4x5", w: 1080, h: 1350 },
  { format: "stories_9x16", w: 1080, h: 1920 },
];
const STATIC_COMPOSITION: Record<StaticArchetype, string> = {
  review: "StaticReview",
  offer: "StaticOffer",
  benefit_authority: "StaticBenefitAuthority",
};

interface StaticEventData {
  workspace_id: string;
  campaign_id: string;
  archetype: string; // legacy (review|offer|benefit_authority) OR killer (advertorial|testimonial|authority|big_claim|before_after)
  copy?: Record<string, string>;
}

export const adToolStaticRequested = inngest.createFunction(
  { id: "ad-tool-static-requested", retries: 1, concurrency: CONCURRENCY, triggers: [{ event: "ad-tool/static-requested" }] },
  async ({ event, step }) => {
    const d = event.data as StaticEventData;
    const { workspace_id, campaign_id, archetype } = d;
    const admin = createAdminClient();
    const isKiller = (KILLER_ARCHETYPES as string[]).includes(archetype);

    // resolve: pick the composition + build its props. Killer archetypes hydrate
    // assets, generate/reuse heroes + copy, and return FRESH signed URLs.
    const base = await step.run("resolve", async () => {
      const { data: c } = await admin.from("ad_campaigns").select("product_id, angle_id").eq("id", campaign_id).single();
      if (!c?.product_id) throw new Error("no_product");
      if (isKiller) {
        const assets = await loadKillerAssets(c.product_id);
        let angle: any = null;
        if (c.angle_id) { const { data: ar } = await admin.from("product_ad_angles").select("*").eq("id", c.angle_id).maybeSingle(); angle = ar; }
        const built = await buildKillerStatic({ workspaceId: workspace_id, productId: c.product_id, archetype: archetype as KillerArchetype, assets, angle });
        return { composition: built.composition, props: built.props, killer: true };
      }
      const inp = await loadStaticInputs(c.product_id);
      const props =
        archetype === "review" ? buildReviewProps(inp, DEFAULT_BRAND)
        : archetype === "offer" ? buildOfferProps(inp, DEFAULT_BRAND, d.copy)
        : buildBenefitAuthorityProps(inp, DEFAULT_BRAND);
      return { composition: STATIC_COMPOSITION[archetype as StaticArchetype], props: props as unknown as Record<string, unknown>, killer: false };
    });

    // Killer statics render both formats (4:5 + 9:16) with Meta safe-zone insets;
    // legacy archetypes keep the 1:1 / 4:5 / 9:16 set.
    const dims = base.killer
      ? KILLER_FORMATS.map((f) => ({ format: f.format, w: f.w, h: f.h, extra: { safeTopPct: f.safeTopPct, safeBottomPct: f.safeBottomPct } as Record<string, unknown> }))
      : STATIC_DIMS.map((f) => ({ format: f.format, w: f.w, h: f.h, extra: {} as Record<string, unknown> }));

    const results = await step.run("render-formats", async () => {
      const out: any[] = [];
      let canonicalId: string | null = null;
      for (const dim of dims) {
        const row: any = { workspace_id, campaign_id, format: dim.format, media_kind: "static", format_variant_of_id: canonicalId, status: "rendering", meta: { archetype } };
        const { data: vrow } = await admin.from("ad_videos").insert(row).select("id").single();
        if (!canonicalId) canonicalId = vrow!.id;
        try {
          const tmp = `/tmp/static_${campaign_id}_${archetype}_${dim.format}.jpg`;
          await renderStillCompositionTo(base.composition, { width: dim.w, height: dim.h, ...dim.extra, ...base.props }, tmp);
          const fs = await import("fs/promises");
          const buf = await fs.readFile(tmp);
          const storagePath = `finals/${workspace_id}/${vrow!.id}.jpg`;
          await uploadBuffer(storagePath, buf, "image/jpeg");
          const url = await signedUrl(storagePath);
          await admin.from("ad_videos").update({ static_jpg_url: url, status: "ready", meta: { archetype, storage_path: storagePath } }).eq("id", vrow!.id);
          out.push({ format: dim.format, id: vrow!.id, ok: true });
        } catch (err: any) {
          await admin.from("ad_videos").update({ status: "failed", meta: { archetype, error: String(err?.message || err) } }).eq("id", vrow!.id);
          out.push({ format: dim.format, id: vrow!.id, ok: false, error: String(err?.message || err) });
        }
      }
      return out;
    });

    return { ok: results.some((r: any) => r.ok), archetype, results };
  },
);

// ── 8. Publish to Meta (Facebook/Instagram ads) ─────────────────────────────
// Upload the campaign's video → wait for Meta processing → ad creative (copy
// variants in asset_feed_spec) → ad in the chosen ad set (PAUSED by default).
// See docs/brain/lifecycles/ad-publish.md + src/lib/meta-ads.ts.
export const adToolPublishToMeta = inngest.createFunction(
  { id: "ad-tool-publish-to-meta", retries: 1, concurrency: CONCURRENCY, triggers: [{ event: "ad-tool/publish-to-meta" }] },
  async ({ event, step }) => {
    const { workspace_id, job_id } = event.data as { workspace_id: string; job_id: string };
    const admin = createAdminClient();
    const setStatus = (status: string, extra: Record<string, unknown> = {}) =>
      admin.from("ad_publish_jobs").update({ publish_status: status, updated_at: new Date().toISOString(), ...extra }).eq("id", job_id);

    const ctx = await step.run("load", async () => {
      const { data: job } = await admin.from("ad_publish_jobs").select("*").eq("id", job_id).single();
      if (!job) throw new Error("job_not_found");
      const { data: campaign } = await admin.from("ad_campaigns").select("name, product_id, angle_id").eq("id", job.campaign_id).single();
      // Gather BOTH ratios for the campaign so we can publish one placement-customized
      // ad — 4:5 in feed, 9:16 in stories/reels (like shopgrowth). Also grab the
      // right_column_1x1 sibling so a complete Dahlia pack routes through Bianca's
      // 3-bucket PLACEMENT builder (bianca-publishes-3-placement-multi-copy-via-
      // placement-customization Phase 2). Falls back to a single asset when only
      // one ratio is ready.
      const { data: vids } = await admin
        .from("ad_videos")
        .select("id, format, media_kind, meta, final_mp4_url, static_jpg_url")
        .eq("campaign_id", job.campaign_id).eq("status", "ready");
      // For the Phase 3 pack-complete gate: load the FULL row set (regardless of
      // status) so `isCreativePackComplete` can distinguish `canonical_missing`
      // (never authored) from `canonical_not_ready` (authored but still rendering
      // / failed) rather than reading a status-filtered view as "missing".
      const { data: allVidsForGate } = await admin
        .from("ad_videos")
        .select("id, format, media_kind, status, format_variant_of_id")
        .eq("campaign_id", job.campaign_id);
      const angleId = (campaign as { angle_id?: string | null } | null)?.angle_id ?? null;
      const { data: angleRow } = angleId
        ? await admin.from("product_ad_angles").select("metadata").eq("id", angleId).maybeSingle()
        : { data: null };
      const all = vids || [];
      const anchor = all.find((v) => v.id === job.video_id) || all[0] || null;
      const mediaKind = (anchor?.media_kind as string) || "video";
      const sameKind = all.filter((v) => (v.media_kind as string) === mediaKind);
      const feed = sameKind.find((v) => v.format === "feed_4x5") || null;
      const story = sameKind.find((v) => v.format === "reels_9x16" || v.format === "stories_9x16") || null;
      const rightColumn = sameKind.find((v) => v.format === "right_column_1x1") || null;
      // Fresh signed URL so Meta can download the media (stored URL may be stale).
      const urlFor = async (v: (typeof all)[number] | null) => {
        if (!v) return null;
        const sp = (v.meta as { storage_path?: string } | null)?.storage_path;
        if (sp) return signedUrl(sp, 60 * 60 * 6);
        return mediaKind === "static" ? v.static_jpg_url : v.final_mp4_url;
      };
      const feedUrl = await urlFor(feed);
      const storyUrl = await urlFor(story);
      const rightColumnUrl = await urlFor(rightColumn);
      const singleUrl = storyUrl || feedUrl || (await urlFor(anchor));
      // 3-bucket PLACEMENT routing decision (Phase 2). Pure predicate on the
      // already-loaded row set + the job's 4×4 copy pack — falls back cleanly to
      // the 2-bucket / single-image path when the pack isn't complete. Phase 3
      // will wrap this with a REFUSAL gate; today an incomplete pack simply
      // renders as the legacy single-asset ad.
      const placementDecision = resolvePlacementPublish({
        mediaKind,
        headlines: (job.headlines as string[] | null) ?? [],
        primaryTexts: (job.primary_texts as string[] | null) ?? [],
        readyAdVideos: sameKind.map((v) => ({
          id: v.id,
          format: v.format,
          media_kind: v.media_kind,
          static_jpg_url: v.static_jpg_url,
          meta: v.meta as { storage_path?: string | null } | null,
        })),
      });
      const token = await getMetaUserToken(workspace_id);
      // Engine-created jobs carry an explicit [ie]-tagged ad_name (Phase 6b); the
      // studio path falls back to the campaign name.
      const adName = (job.ad_name as string | null) || campaign?.name || "ShopCX Ad";
      const productId = (campaign as { product_id?: string | null } | null)?.product_id ?? null;
      // Resolve the account's UUID (meta_ad_accounts.id) from the bare act id the job carries — the
      // media-buyer publish gate resolves the per-product cohort by (account UUID, productId), and the
      // job row only stores the act id. Without this the publisher's re-check can't find a per-account/
      // per-product cohort (it would see a null account and refuse). See [[../media-buyer/publish-gate]].
      const { data: acctRow } = await admin
        .from("meta_ad_accounts")
        .select("id")
        .eq("workspace_id", workspace_id)
        .eq("meta_account_id", job.meta_account_id)
        .maybeSingle();
      const metaAdAccountRowId = (acctRow as { id: string } | null)?.id ?? null;
      // Phase 3 — pack-complete publish gate. `evaluateCreativePackGate` is a pure
      // predicate over the FULL ad_videos row set + the angle's `metadata.copy_pack`.
      // A Dahlia-authored static campaign whose pack is incomplete REFUSES rather
      // than silently degrading to a single-image ad (bianca-publishes-3-placement-
      // multi-copy-via-placement-customization Phase 3). Video / non-Dahlia campaigns
      // are `skipped` so the legacy paths keep running.
      const gateAdVideos = (allVidsForGate || []).map((r) => ({
        format: String(r.format),
        media_kind: String(r.media_kind),
        status: String(r.status),
        format_variant_of_id: (r.format_variant_of_id as string | null) ?? null,
      }));
      const canonicalRow = (allVidsForGate || []).find(
        (r) => r.format === "feed_4x5" && ((r as { format_variant_of_id?: string | null }).format_variant_of_id ?? null) === null,
      ) as { id?: string } | undefined;
      const packSnapshot: CreativePackSnapshot = {
        adVideos: gateAdVideos,
        canonicalId: canonicalRow?.id ?? null,
        angleMetadata: (angleRow?.metadata as { copy_pack?: { headlines?: unknown; primaryTexts?: unknown } | null } | null) ?? null,
      };
      const packGate = evaluateCreativePackGate({ mediaKind, snapshot: packSnapshot });
      return { job, adName, mediaKind, feedUrl, storyUrl, rightColumnUrl, singleUrl, token, productId, metaAdAccountRowId, placementDecision, packGate };
    });

    if (!ctx.token) { await setStatus("failed", { error: "meta_not_connected" }); return { ok: false, reason: "meta_not_connected" }; }
    // Phase 3 refusal — a Dahlia-authored static campaign whose pack is incomplete
    // MUST NOT ship as a degraded single-image ad. `evaluateCreativePackGate`
    // returns `allowed:false` only when the campaign is Dahlia-authored (a
    // `feed_4x5` canonical row exists) AND the pack is incomplete; video / legacy
    // studio campaigns are `skipped` and fall through to the normal publish paths.
    // On refusal: status=failed with reason=`missing_creative_pack`, publish_active
    // cleared so no ad exists, and a deduped CEO escalation + growth-owned
    // director_activity row records what to fix.
    const j0 = ctx.job as any;
    if (!ctx.packGate.allowed) {
      const diagnosis = missingCreativePackDiagnosis({
        packReason: ctx.packGate.packReason,
        detail: ctx.packGate.detail,
        campaignId: String(j0.campaign_id ?? ""),
      });
      await setStatus("failed", {
        error: `${MISSING_CREATIVE_PACK_REASON}:${ctx.packGate.packReason}`,
        publish_active: false,
      });
      const dedupeKey = `bianca_pack_gate:${workspace_id}:${String(j0.campaign_id ?? "")}:${ctx.packGate.packReason}`;
      const escalationMetadata = {
        origin: (j0.origin as string | null) ?? null,
        reason: MISSING_CREATIVE_PACK_REASON,
        pack_reason: ctx.packGate.packReason,
        job_id,
        campaign_id: (j0.campaign_id as string) ?? null,
        product_id: ctx.productId ?? null,
        media_kind: ctx.mediaKind,
      } as const;
      const ceo = await escalateDiagnosisToCeo(admin, {
        workspaceId: workspace_id,
        specSlug: null,
        title: `Bianca publish refused: incomplete creative pack (${ctx.packGate.packReason})`,
        diagnosis,
        dedupeKey,
        deepLink: "/dashboard/marketing/ads",
        escalationKind: "bianca_missing_creative_pack",
        metadata: escalationMetadata,
      });
      if (ceo.emitted) {
        await recordDirectorActivity(admin, {
          workspaceId: workspace_id,
          directorFunction: "growth",
          actionKind: "bianca_missing_creative_pack",
          specSlug: null,
          reason: diagnosis,
          metadata: { ...escalationMetadata, dedupe_key: dedupeKey, autonomous: true },
        });
      }
      return { ok: false, reason: MISSING_CREATIVE_PACK_REASON, packReason: ctx.packGate.packReason };
    }
    if (!ctx.singleUrl) { await setStatus("failed", { error: "no_media_url" }); return { ok: false, reason: "no_media_url" }; }
    const j = ctx.job as any;
    const isStatic = ctx.mediaKind === "static";
    const dual = !!(ctx.feedUrl && ctx.storyUrl);
    // 3-bucket PLACEMENT publish is eligible when the pack is complete AND all
    // three signed URLs resolved (the resolver already asserts the pack shape;
    // the URL check catches a storage_path that failed to sign).
    const placementReady = isStatic
      && ctx.placementDecision.ready
      && !!ctx.feedUrl
      && !!ctx.storyUrl
      && !!ctx.rightColumnUrl;

    // Fail closed on a resolved publish path that would submit a placement-
    // customized creative to Meta with no linked Instagram identity. Meta's
    // `createPlacementCreative` / `createDualAssetCreative` builders attach
    // asset-customization rules for IG placements; without
    // `object_story_spec.instagram_user_id` Meta rejects them with a 400. The
    // publisher already has everything it needs to make this decision, so it
    // refuses cleanly here rather than letting `/api/inngest` emit an
    // unhandled Graph error. See src/lib/ads/publish-instagram-identity-guard.ts.
    if (shouldRefuseForMissingInstagramIdentity({
      placementReady,
      dual,
      instagramUserId: j.meta_instagram_user_id as string | null | undefined,
    })) {
      await setStatus("failed", { error: MISSING_INSTAGRAM_IDENTITY_REASON });
      return { ok: false, reason: MISSING_INSTAGRAM_IDENTITY_REASON };
    }

    const result = await step.run("publish", async () => {
      try {
        // dahlia-publisher-asset-feed-spec-upgrade-and-competitor-selection Phase 1 —
        // temperature-banded pack lands here as `j.descriptions` (jsonb string-array); when
        // present it's the N-entry multi-variant descriptions that Meta's asset_feed_spec
        // receives 1:1. When null (legacy studio / deterministic-mode job), fall back to
        // [description] single-element so byte-identical behavior is preserved.
        const jobDescriptions = (j.descriptions as string[] | null) ?? null;
        const descriptions = jobDescriptions?.length
          ? jobDescriptions.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
          : (typeof j.description === "string" && j.description.trim().length > 0 ? [j.description as string] : []);
        const baseCreative = {
          accountId: j.meta_account_id,
          name: ctx.adName,
          pageId: j.meta_page_id,
          instagramUserId: j.meta_instagram_user_id,
          headlines: j.headlines || [],
          primaryTexts: j.primary_texts || [],
          description: j.description,
          descriptions,
          ctaType: j.cta_type,
          destinationUrl: j.destination_url,
          // utm_content={{ad.id}} is Meta's dynamic-URL token — Meta substitutes the
          // real ad id per click at delivery time, so orders.attributed_utm_content
          // resolves to meta_ad_id (attribution-sensor-recalibration Phase 2).
          urlTags: `utm_source=meta&utm_medium=paid_social&utm_campaign=${encodeURIComponent(ctx.adName)}&utm_content={{ad.id}}`,
        };

        let creativeId: string;
        let videoId: string | null = null;
        const fetchBytes = async (u: string) => Buffer.from(await (await fetch(u)).arrayBuffer());

        if (placementReady) {
          // Complete Dahlia pack → ONE portable (non-DCO) 3-placement PLACEMENT ad:
          // 4:5 in feed, 9:16 in stories/reels, 1:1 in right-column + FB search,
          // rotating the 4 headlines + 4 primary texts across every placement.
          // Battle-tested by creative 780957111743379 (bianca-publishes-3-placement-
          // multi-copy-via-placement-customization Phase 2 wiring; Phase 1 built the
          // meta-ads.ts builder).
          await setStatus("uploading");
          const [fb, sb, rb] = await Promise.all([
            fetchBytes(ctx.feedUrl!),
            fetchBytes(ctx.storyUrl!),
            fetchBytes(ctx.rightColumnUrl!),
          ]);
          const [feedImageHash, storyImageHash, rightColumnImageHash] = await Promise.all([
            uploadAdImage(ctx.token!, j.meta_account_id, fb, "feed.jpg"),
            uploadAdImage(ctx.token!, j.meta_account_id, sb, "story.jpg"),
            uploadAdImage(ctx.token!, j.meta_account_id, rb, "rightcol.jpg"),
          ]);
          await setStatus("creating");
          creativeId = await createPlacementCreative(ctx.token!, {
            ...baseCreative,
            feedImageHash,
            storyImageHash,
            rightColumnImageHash,
          });
        } else if (dual && isStatic) {
          // Both ratios → one placement-customized image ad (4:5 feed, 9:16 stories).
          await setStatus("uploading");
          const [fb, sb] = await Promise.all([fetchBytes(ctx.feedUrl!), fetchBytes(ctx.storyUrl!)]);
          const [feedImageHash, storyImageHash] = await Promise.all([
            uploadAdImage(ctx.token!, j.meta_account_id, fb, "feed.jpg"),
            uploadAdImage(ctx.token!, j.meta_account_id, sb, "story.jpg"),
          ]);
          await setStatus("creating");
          creativeId = await createDualAssetCreative(ctx.token!, { ...baseCreative, feedImageHash, storyImageHash });
        } else if (dual && !isStatic) {
          // Both ratios → one placement-customized video ad (4:5 feed, 9:16 reels/stories).
          await setStatus("uploading");
          const [feedVid, storyVid] = await Promise.all([
            uploadAdVideo(ctx.token!, j.meta_account_id, ctx.feedUrl!, `${ctx.adName} (feed)`),
            uploadAdVideo(ctx.token!, j.meta_account_id, ctx.storyUrl!, `${ctx.adName} (reels)`),
          ]);
          videoId = storyVid;
          await admin.from("ad_publish_jobs").update({ meta_video_id: storyVid }).eq("id", job_id);
          await Promise.all([
            waitForVideoReady(ctx.token!, feedVid, { timeoutMs: 300000 }),
            waitForVideoReady(ctx.token!, storyVid, { timeoutMs: 300000 }),
          ]);
          await setStatus("creating");
          creativeId = await createDualAssetCreative(ctx.token!, { ...baseCreative, feedVideoId: feedVid, storyVideoId: storyVid });
        } else if (isStatic) {
          // Single static (image) ad.
          await setStatus("uploading");
          const imageHash = await uploadAdImage(ctx.token!, j.meta_account_id, await fetchBytes(ctx.singleUrl!), "static.jpg");
          await setStatus("creating");
          creativeId = await createAdCreative(ctx.token!, { ...baseCreative, imageHash });
        } else {
          // Single video ad.
          await setStatus("uploading");
          videoId = await uploadAdVideo(ctx.token!, j.meta_account_id, ctx.singleUrl!, ctx.adName);
          await admin.from("ad_publish_jobs").update({ meta_video_id: videoId }).eq("id", job_id);
          await waitForVideoReady(ctx.token!, videoId, { timeoutMs: 300000 });

          await setStatus("creating");
          // Video ads need a thumbnail. asset_feed_spec wants a thumbnail_hash, so
          // pull Meta's auto-generated thumbnail and re-upload it to get a hash.
          let thumbnailHash: string | null = null;
          const thumbnailUrl = await getVideoThumbnail(ctx.token!, videoId);
          if (thumbnailUrl) {
            try {
              thumbnailHash = await uploadAdImage(ctx.token!, j.meta_account_id, await fetchBytes(thumbnailUrl));
            } catch { /* fall through — creative create will surface a thumbnail error if truly required */ }
          }
          creativeId = await createAdCreative(ctx.token!, { ...baseCreative, videoId, thumbnailHash });
        }
        await admin.from("ad_publish_jobs").update({ meta_creative_id: creativeId }).eq("id", job_id);

        // Per-test-adset path (media-buyer per-test cohort): this job carries a `create_adset_spec` —
        // instead of publishing into a shared adset, mint a DEDICATED ~$150/day ad set for THIS one
        // creative so the whole budget tests it (the researched ABO model). The gate runs FIRST (below)
        // using the spec's budget + a concurrency recount, so a refusal keeps the freshly-minted adset
        // PAUSED (zero spend). Idempotency: a retry after the adset was already created reuses the stamped
        // meta_adset_id (the load step re-reads it) — never a second ad set.
        const perTestSpec = (j.create_adset_spec as CreateAdsetSpec | null) ?? null;

        // Media-Buyer test-cohort gate — belt-and-suspenders re-check
        // (media-buyer-test-winner-loop Phase 1). The publish route runs the same
        // gate BEFORE inserting the job, but a script/enqueue path may bypass the
        // route entirely, and the cohort could have been retired between insert
        // and publisher execution. Re-verify here: on refusal we DOWNGRADE the
        // ad to PAUSED (never silently spend) and escalate to the CEO. The refusal
        // is idempotent-safe — escalateDiagnosisToCeo dedupes on the same key the
        // route used, so a route-caught refusal doesn't fan out a duplicate.
        //
        // Per-test mode: gate on the SPEC's daily budget (the adset isn't minted yet), scoped to the
        // campaign's product so the per-product cohort's ceiling/concurrency is enforced.
        let effectivePublishActive = !!j.publish_active;
        if (effectivePublishActive && j.origin === MEDIA_BUYER_TEST_ORIGIN) {
          const gateAdsetId = perTestSpec ? `pending:${job_id}` : String(j.meta_adset_id);
          const gateProjected = perTestSpec
            ? Math.round(Number(perTestSpec.daily_budget_cents))
            : (Number.isFinite(Number(j.projected_daily_cents)) ? Math.round(Number(j.projected_daily_cents)) : 0);
          const gate = await evaluateMediaBuyerTestPublish(admin, {
            workspaceId: workspace_id,
            metaAdAccountId: ctx.metaAdAccountRowId ?? (j.meta_ad_account_row_id as string | null) ?? null,
            productId: ctx.productId ?? null,
            metaAdsetId: gateAdsetId,
            projectedDailyCents: gateProjected,
          });
          if (!gate.allowed) {
            effectivePublishActive = false;
            await escalateMediaBuyerTestPublishRefusal(admin, {
              workspaceId: workspace_id,
              metaAdsetId: gateAdsetId,
              metaAdAccountId: ctx.metaAdAccountRowId ?? (j.meta_ad_account_row_id as string | null) ?? null,
              projectedDailyCents: gate.projectedDailyCents,
              reason: gate.reason,
              diagnosis: gate.diagnosis,
              ceilingCents: gate.ceilingCents,
              jobId: job_id,
              campaignId: (j.campaign_id as string) ?? null,
            });
            await admin.from("ad_publish_jobs").update({ publish_active: false }).eq("id", job_id);
          }
        }

        // Mint the per-test ad set (if this job carries a spec) with the gated status — ACTIVE only when
        // the gate allowed it, PAUSED otherwise (so a refused publish creates an idle, zero-spend adset).
        let effectiveAdsetId: string | null = (j.meta_adset_id as string | null) ?? null;
        if (perTestSpec && !effectiveAdsetId) {
          effectiveAdsetId = await createAdSet(ctx.token!, j.meta_account_id, {
            name: perTestSpec.name,
            campaignId: perTestSpec.campaign_id,
            dailyBudgetCents: perTestSpec.daily_budget_cents,
            pixelId: perTestSpec.pixel_id,
            customEventType: perTestSpec.custom_event_type,
            optimizationGoal: perTestSpec.optimization_goal,
            billingEvent: perTestSpec.billing_event,
            bidStrategy: perTestSpec.bid_strategy,
            targeting: perTestSpec.targeting,
            status: effectivePublishActive ? "ACTIVE" : "PAUSED",
          });
          await admin.from("ad_publish_jobs").update({ meta_adset_id: effectiveAdsetId }).eq("id", job_id);
        }
        if (!effectiveAdsetId) {
          await setStatus("failed", { error: "no_adset_id" });
          return { ok: false, reason: "no_adset_id" };
        }

        const adId = await createAd(ctx.token!, j.meta_account_id, {
          name: ctx.adName,
          adsetId: effectiveAdsetId,
          creativeId,
          status: effectivePublishActive ? "ACTIVE" : "PAUSED",
        });
        await setStatus("published", { meta_video_id: videoId, meta_creative_id: creativeId, meta_ad_id: adId, error: null });
        // Phase 6b write-back: if this job fulfills an iteration_recommendation,
        // record the engine-created Meta ids on it and flip status → executed.
        if (j.recommendation_id) {
          await admin
            .from("iteration_recommendations")
            .update({
              status: "executed",
              external_result: {
                ad_publish_job_id: job_id,
                meta_ad_id: adId,
                meta_creative_id: creativeId,
                meta_video_id: videoId,
              },
              executed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", j.recommendation_id);
        }
        return { ok: true, adId };
      } catch (err: any) {
        await setStatus("failed", { error: String(err?.message || err).slice(0, 300) });
        if (j.recommendation_id) {
          await admin
            .from("iteration_recommendations")
            .update({
              status: "failed",
              external_result: { ad_publish_job_id: job_id, error: String(err?.message || err).slice(0, 300) },
              updated_at: new Date().toISOString(),
            })
            .eq("id", j.recommendation_id);
        }
        throw err;
      }
    });

    return result;
  },
);

// ── Full-ad orchestrator ─────────────────────────────────────────────────────
// Stages normally run one-at-a-time from the campaign page. This chains them for
// one campaign so an ad can be produced fire-and-forget (used to batch-build a
// set of ads): hero → talking head → N avatar b-roll → render, sequentially via
// step.invoke (each invoke awaits the stage's completion). Concurrency 1/workspace
// so a batch of these serializes and doesn't burst past Veo's rate cap.
interface GenerateFullEventData {
  workspace_id: string;
  campaign_id: string;
  broll_actions?: string[]; // AVATAR_BROLL_ACTIONS values (avatar b-roll clips to add)
}

export const adToolGenerateFull = inngest.createFunction(
  { id: "ad-tool-generate-full", retries: 0, concurrency: [{ limit: 1, key: "event.data.workspace_id" }], triggers: [{ event: "ad-tool/generate-full" }] },
  async ({ event, step }) => {
    const { workspace_id, campaign_id, broll_actions } = event.data as GenerateFullEventData;

    const hero = (await step.invoke("hero", { function: adToolHeroRequested, data: { workspace_id, campaign_id } })) as { ok?: boolean; reason?: string };
    if (!hero?.ok) return { ok: false, stage: "hero", reason: hero?.reason };

    const th = (await step.invoke("talking-head", { function: adToolTalkingHeadRequested, data: { workspace_id, campaign_id } })) as { ok?: boolean; reason?: string };
    if (!th?.ok) return { ok: false, stage: "talking-head", reason: th?.reason };

    // Avatar b-roll — sequential (Veo cap). A failed clip doesn't abort the ad.
    const actions = (broll_actions || []).slice(0, 2);
    for (let i = 0; i < actions.length; i++) {
      await step.invoke(`broll-${i}`, { function: adToolBrollRequested, data: { workspace_id, campaign_id, mode: "avatar", avatar_action: actions[i] } });
    }

    const render = await step.invoke("render", { function: adToolRenderRequested, data: { workspace_id, campaign_id } });
    return { ok: true, render };
  },
);

// ── Advertorial lander (auto-generated when a campaign reaches ready) ────────
// Generates the ad-matched landing page(s) for the campaign's angle so the ad +
// its scent-matched lander ship together. Idempotent (upsert by product+slug).
export const adToolAdvertorialPageRequested = inngest.createFunction(
  { id: "ad-tool-advertorial-page-requested", retries: 1, concurrency: CONCURRENCY, triggers: [{ event: "ad-tool/advertorial-page-requested" }] },
  async ({ event }) => {
    const { workspace_id, campaign_id } = event.data as EventData;
    return generateAdvertorialPagesForCampaign(workspace_id, campaign_id);
  },
);

export const adToolFunctions = [
  adToolFaceRequested,
  adToolHeroRequested,
  adToolTalkingHeadRequested,
  adToolBrollRequested,
  adToolMusicRequested,
  adToolRenderRequested,
  adToolSegmentRegenerate,
  adToolStaticRequested,
  adToolPublishToMeta,
  adToolGenerateFull,
  adToolAdvertorialPageRequested,
];

// keep imports used even if tree-shaken in some builds
void creditsToCents;
