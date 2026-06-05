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
import { buildAvatarPortraitPrompt, slugify, resolveAdToolSettings, VIDEO_FORMATS, STATIC_FORMATS, FORMAT_SPECS, type AdFormat, type VibeTag, type AvatarFaceAttributes } from "@/lib/ad-tool-config";
import { loadAngleInputs } from "@/lib/ad-angles";
import { transcribeWords } from "@/lib/ad-transcribe";
import { composeCredibility, buildCompositionProps, renderAdFormat, buildVoCaptions, renderVoSpineVideo } from "@/lib/ad-render";

// Veo talking-head prompt: strict "say ONLY these words" to suppress Veo's
// hallucinated filler (we still proofread captions, but tighter input = cleaner).
function buildTalkingHeadPrompt(productTitle: string, script: string): string {
  return `A person holding the ${productTitle} speaks directly to camera with warm, casual, confident UGC energy. They say ONLY these exact words and NOTHING else — no extra words, no filler, no improvisation, no repetition: "${script}" Authentic handheld selfie video, natural daylight, subtle real movement, relaxed unhurried pace. NO background music. Do NOT add any on-screen text, captions, subtitles, or words burned into the footage.`;
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
function buildHoldingProductPrompt(productTitle: string, dims: any, vibeTags: string[]): string {
  const shape = dims?.shape || "package";
  let prompt = `Create a photorealistic vertical 9:16 UGC selfie-style photo: the person from the FIRST image holding the ${shape} of ${productTitle} from the SECOND image in their hands at chest height, facing the camera with a warm authentic smile, natural daylight outdoors. Keep their face and identity IDENTICAL to the first image. Reproduce the product packaging artwork and ALL text exactly and sharply from the second image. Realistic hands with exactly five fingers.`;
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
        .select("id, product_id, variant_id, avatar_id, vibe_tags, products(title)")
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
      return { campaign: c, faceUrl: (avatar?.reference_image_urls as string[] | null)?.[0] || null, isoUrl, dims };
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
    let prompt = buildHoldingProductPrompt(productTitle, ctx.dims, (ctx.campaign?.vibe_tags as string[]) || []);
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
      const { data } = await admin.from("ad_campaigns").select("hero_image_url, script_text, length_sec, products(title)").eq("id", campaign_id).single();
      return data;
    });
    if (!campaign?.hero_image_url) return { ok: false, reason: "missing_hero" };
    const productTitle = (campaign as any)?.products?.title || "the product";
    const scripts = splitScriptIntoSegments(campaign.script_text || "", campaign.length_sec || 15);
    if (!scripts.length) return { ok: false, reason: "no_script" };

    // One Veo clip per beat, generated sequentially (Veo Fast has a daily cap;
    // bursting risks 429). Each persists as its own ad_segments row.
    const segs = await step.run("veo-generate-persist", async () => {
      // Fresh generation replaces any prior talking-head clips (incl. failed ones).
      await admin.from("ad_segments").update({ is_active: false }).eq("campaign_id", campaign_id).eq("kind", "talking_head");
      const out: Array<{ segId: string; ok: boolean; error?: string }> = [];
      for (let i = 0; i < scripts.length; i++) {
        const prompt = buildTalkingHeadPrompt(productTitle, scripts[i]);
        const segId = await createSegment({ workspaceId: workspace_id, campaignId: campaign_id, kind: "talking_head", seq: i, scriptText: scripts[i], prompt, model: VEO_FAST_MODEL });
        try {
          const { buffer } = await generateVeoVideo({ workspaceId: workspace_id, prompt, imageUrl: campaign.hero_image_url!, aspectRatio: "9:16", model: VEO_FAST_MODEL, timeoutMs: 360000 });
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
  mode: "text" | "image";
  prompt?: string;
  source_url?: string;
  model?: "fast" | "full";
}

export const adToolBrollRequested = inngest.createFunction(
  { id: "ad-tool-broll-requested", retries: 1, concurrency: CONCURRENCY, triggers: [{ event: "ad-tool/broll-requested" }] },
  async ({ event, step }) => {
    const d = event.data as BrollEventData;
    const { workspace_id, campaign_id } = d;
    const mode = d.mode === "text" ? "text" : "image";
    const veoModel = d.model === "full" ? VEO_MODEL : VEO_FAST_MODEL;
    const admin = createAdminClient();

    const ctx = await step.run("load", async () => {
      const { data: c } = await admin.from("ad_campaigns").select("products(title)").eq("id", campaign_id).single();
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
      return { productTitle: (c as any)?.products?.title || "the product", nextSeq: (existing?.seq ?? -1) + 1 };
    });

    const sourceUrl = mode === "image" ? d.source_url || null : null;
    if (mode === "image" && !sourceUrl) return { ok: false, reason: "image_mode_needs_source" };
    const prompt = (d.prompt || "").trim() || buildBrollPrompt(ctx.productTitle);

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
            await renderVoSpineVideo(
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
            await renderAdFormat(props, tmp);
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
      const { data: c } = await admin.from("ad_campaigns").select("hero_image_url, products(title)").eq("id", campaign_id).single();
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
      return { hero: c?.hero_image_url || null, productTitle: (c as any)?.products?.title || "the product", existing };
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
          const { buffer } = await generateVeoVideo({ workspaceId: workspace_id, prompt, imageUrl: sourceUrl || undefined, aspectRatio: "9:16", model: veoModel, timeoutMs: 360000 });
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
      const prompt = buildTalkingHeadPrompt(ctx.productTitle, script);
      const id = await regenerateSegment({ workspaceId: workspace_id, campaignId: campaign_id, kind: "talking_head", seq, scriptText: script, prompt, model: veoModel });
      try {
        const { buffer } = await generateVeoVideo({ workspaceId: workspace_id, prompt, imageUrl: ctx.hero, aspectRatio: "9:16", model: veoModel, timeoutMs: 360000 });
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

export const adToolFunctions = [
  adToolFaceRequested,
  adToolHeroRequested,
  adToolTalkingHeadRequested,
  adToolBrollRequested,
  adToolMusicRequested,
  adToolRenderRequested,
  adToolSegmentRegenerate,
];

// keep imports used even if tree-shaken in some builds
void creditsToCents;
