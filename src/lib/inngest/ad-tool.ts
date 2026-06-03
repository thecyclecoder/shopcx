/**
 * Ad tool — async generation pipeline (Higgsfield + Whisper + Remotion).
 *
 * One function per stage; all keyed concurrency=3 per workspace so a single
 * workspace can't monopolize Higgsfield rate limits. Every Higgsfield call is
 * logged to ad_jobs by the client wrapper for audit/replay.
 *
 *   ad-tool/hero-requested        → Soul hero image
 *   ad-tool/audio-requested       → TTS audio
 *   ad-tool/talking-head-requested→ Speak lip-sync (1 clip @15s, 2 @30s)
 *   ad-tool/broll-requested       → N parallel DoP clips
 *   ad-tool/render-requested      → Whisper + Remotion, 4 formats
 *
 * See docs/brain/specs/ad-tool.md Phases 3-5.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  generateSoulImage,
  generateTtsAudio,
  generateSpeakVideo,
  generateDopVideo,
  pollJobUntilDone,
  creditsToCents,
} from "@/lib/higgsfield";
import { uploadFromUrl, signedUrl } from "@/lib/ad-storage";
import { eligibleMotions, slugify, resolveAdToolSettings, VIDEO_FORMATS, STATIC_FORMATS, type AdFormat, type VibeTag } from "@/lib/ad-tool-config";
import { loadAngleInputs } from "@/lib/ad-angles";
import { transcribeWords } from "@/lib/ad-transcribe";
import { composeCredibility, buildCompositionProps, renderAdFormat } from "@/lib/ad-render";

const CONCURRENCY: [{ limit: number; key: string }] = [{ limit: 3, key: "event.data.workspace_id" }];

type EventData = { workspace_id: string; campaign_id: string; video_id?: string };

// ── Soul prompt builder ──────────────────────────────────────────────────────
function buildSoulPrompt(avatarName: string, productTitle: string, dims: any, vibeTags: string[]): string {
  const shape = dims?.shape || "product";
  const l = dims?.length_in ?? 6;
  const w = dims?.width_in ?? 3;
  const h = dims?.height_in ?? 8;
  let prompt = `${avatarName} holding a ${l}-inch by ${h}-inch ${shape} of ${productTitle}, studio lighting, clean background, mid-shot, looking at camera, smiling, photorealistic. The ${shape} measures approximately ${l}" × ${w}" × ${h}", so size it proportionally in the avatar's hand — not as a small handheld item, but realistically scaled.`;
  if (vibeTags.includes("ugly")) prompt += " Asymmetric framing, oversaturated color grading, slight motion blur, phone-camera look.";
  if (vibeTags.includes("clinical")) prompt += " Harsh fluorescent lighting, lab-counter background.";
  if (vibeTags.includes("phone_recorded")) prompt += " Handheld phone photo, slightly off-center.";
  return prompt;
}

// ── 1. Hero (Soul) ────────────────────────────────────────────────────────────
export const adToolHeroRequested = inngest.createFunction(
  { id: "ad-tool-hero-requested", retries: 2, concurrency: CONCURRENCY, triggers: [{ event: "ad-tool/hero-requested" }] },
  async ({ event, step }) => {
    const { workspace_id, campaign_id } = event.data as EventData;
    const admin = createAdminClient();

    const ctx = await step.run("load", async () => {
      const { data: c } = await admin
        .from("ad_campaigns")
        .select("id, product_id, variant_id, avatar_id, vibe_tags, products(title)")
        .eq("id", campaign_id)
        .single();
      const { data: avatar } = await admin.from("ad_avatars").select("name, higgsfield_character_id").eq("id", c?.avatar_id).single();
      let isoUrl: string | null = null;
      let dims: any = null;
      if (c?.variant_id) {
        const { data: v } = await admin.from("product_variants").select("isolated_image_url, physical_dimensions").eq("id", c.variant_id).single();
        isoUrl = v?.isolated_image_url || null;
        dims = v?.physical_dimensions || null;
      }
      if (!dims) {
        const { data: p } = await admin.from("products").select("physical_dimensions").eq("id", c?.product_id).single();
        dims = p?.physical_dimensions || null;
      }
      return { campaign: c, avatar, isoUrl, dims };
    });

    if (!ctx.avatar?.higgsfield_character_id) {
      await admin.from("ad_campaigns").update({ status: "failed" }).eq("id", campaign_id);
      return { ok: false, reason: "no_character" };
    }

    const productTitle = (ctx.campaign as any)?.products?.title || "the product";
    const prompt = buildSoulPrompt(ctx.avatar.name, productTitle, ctx.dims, (ctx.campaign?.vibe_tags as string[]) || []);

    const heroUrl = await step.run("soul-generate-poll", async () => {
      // Sign the isolated image so Higgsfield can read it (private bucket).
      let refUrls: string[] = [];
      if (ctx.isoUrl) {
        try {
          refUrls = [ctx.isoUrl.includes("/storage/") ? await signedFromPublicish(ctx.isoUrl) : ctx.isoUrl];
        } catch {
          refUrls = [ctx.isoUrl];
        }
      }
      const { jobSetId } = await generateSoulImage({
        workspaceId: workspace_id,
        characterId: ctx.avatar!.higgsfield_character_id!,
        prompt,
        referenceImageUrls: refUrls,
        quality: "1080p",
        campaignId: campaign_id,
      });
      if (!jobSetId) throw new Error("no_job_set");
      const res = await pollJobUntilDone(workspace_id, jobSetId, { timeoutMs: 180000 });
      if (res.status !== "completed" || !res.outputUrls[0]) throw new Error(`soul_${res.status}`);
      const path = `avatars/${workspace_id}/heroes/${campaign_id}.png`;
      await uploadFromUrl(path, res.outputUrls[0], "image/png");
      return signedUrl(path);
    });

    await admin.from("ad_campaigns").update({ hero_image_url: heroUrl }).eq("id", campaign_id);
    await step.sendEvent("hero-completed", { name: "ad-tool/hero-completed", data: { workspace_id, campaign_id } });
    return { ok: true, heroUrl };
  },
);

// Helper: a stored "public-ish" URL we still want to re-sign (best effort).
async function signedFromPublicish(url: string): Promise<string> {
  return url; // isolated images are stored in product-media (already accessible); pass through.
}

// ── 2. Audio (TTS) ────────────────────────────────────────────────────────────
export const adToolAudioRequested = inngest.createFunction(
  { id: "ad-tool-audio-requested", retries: 2, concurrency: CONCURRENCY, triggers: [{ event: "ad-tool/audio-requested" }] },
  async ({ event, step }) => {
    const { workspace_id, campaign_id } = event.data as EventData;
    const admin = createAdminClient();
    const campaign = await step.run("load", async () => {
      const { data } = await admin.from("ad_campaigns").select("script_text, voice_id").eq("id", campaign_id).single();
      return data;
    });
    if (!campaign?.script_text) return { ok: false, reason: "no_script" };

    const audioUrl = await step.run("tts-generate-poll", async () => {
      const { jobSetId } = await generateTtsAudio({
        workspaceId: workspace_id,
        text: campaign.script_text,
        voiceId: campaign.voice_id || "default",
        campaignId: campaign_id,
      });
      if (!jobSetId) throw new Error("no_job_set");
      const res = await pollJobUntilDone(workspace_id, jobSetId, { timeoutMs: 120000 });
      if (res.status !== "completed" || !res.outputUrls[0]) throw new Error(`tts_${res.status}`);
      const path = `audio/${workspace_id}/${campaign_id}.mp3`;
      await uploadFromUrl(path, res.outputUrls[0], "audio/mpeg");
      return signedUrl(path);
    });

    await admin.from("ad_campaigns").update({ audio_url: audioUrl }).eq("id", campaign_id);
    await step.sendEvent("audio-completed", { name: "ad-tool/audio-completed", data: { workspace_id, campaign_id } });
    return { ok: true, audioUrl };
  },
);

// ── 3. Talking head (Speak) ─────────────────────────────────────────────────
export const adToolTalkingHeadRequested = inngest.createFunction(
  { id: "ad-tool-talking-head-requested", retries: 2, concurrency: CONCURRENCY, triggers: [{ event: "ad-tool/talking-head-requested" }] },
  async ({ event, step }) => {
    const { workspace_id, campaign_id } = event.data as EventData;
    const admin = createAdminClient();
    const campaign = await step.run("load", async () => {
      const { data } = await admin.from("ad_campaigns").select("hero_image_url, audio_url, script_text, length_sec").eq("id", campaign_id).single();
      return data;
    });
    if (!campaign?.hero_image_url || !campaign?.audio_url) return { ok: false, reason: "missing_hero_or_audio" };

    // 15s ad: single 15s gen. 30s ad: two 15s gens (Speak max = 15s/gen).
    const segments = campaign.length_sec >= 30 ? 2 : 1;
    const urls = await step.run("speak-generate-poll", async () => {
      const out: string[] = [];
      for (let s = 0; s < segments; s++) {
        const { jobSetId } = await generateSpeakVideo({
          workspaceId: workspace_id,
          imageUrl: campaign.hero_image_url,
          audioUrl: campaign.audio_url,
          prompt: campaign.script_text || "",
          duration: 15,
          quality: "1080p",
          campaignId: campaign_id,
        });
        if (!jobSetId) throw new Error("no_job_set");
        const res = await pollJobUntilDone(workspace_id, jobSetId, { timeoutMs: 240000 });
        if (res.status !== "completed" || !res.outputUrls[0]) throw new Error(`speak_${res.status}`);
        const path = `talking-head/${workspace_id}/${campaign_id}_${s}.mp4`;
        await uploadFromUrl(path, res.outputUrls[0], "video/mp4");
        out.push(await signedUrl(path));
      }
      return out;
    });

    await step.sendEvent("th-completed", { name: "ad-tool/talking-head-completed", data: { workspace_id, campaign_id } });
    return { ok: true, segments: urls };
  },
);

// ── 4. B-roll (DoP) ──────────────────────────────────────────────────────────
export const adToolBrollRequested = inngest.createFunction(
  { id: "ad-tool-broll-requested", retries: 2, concurrency: CONCURRENCY, triggers: [{ event: "ad-tool/broll-requested" }] },
  async ({ event, step }) => {
    const { workspace_id, campaign_id } = event.data as EventData;
    const admin = createAdminClient();
    const ctx = await step.run("load", async () => {
      const { data: c } = await admin.from("ad_campaigns").select("product_id, vibe_tags").eq("id", campaign_id).single();
      // Lifestyle shots first, packshots second.
      const { data: media } = await admin
        .from("product_media")
        .select("url, webp_1080_url, slot, display_order")
        .eq("product_id", c?.product_id)
        .order("display_order", { ascending: true })
        .limit(8);
      return { vibe: (c?.vibe_tags as string[]) || [], media: media || [] };
    });

    const sources = ctx.media.filter((m) => m.slot !== "hero").slice(0, 3);
    if (sources.length < 1) return { ok: false, reason: "no_broll_sources" };
    const motions = eligibleMotions(ctx.vibe);

    const clips = await step.run("dop-generate-poll", async () => {
      const out: Array<{ image_url: string; video_url: string; motion_id: string }> = [];
      for (let i = 0; i < sources.length; i++) {
        const src = sources[i];
        const imageUrl = src.webp_1080_url || src.url;
        const motionId = motions[i % motions.length];
        const { jobSetId } = await generateDopVideo({ workspaceId: workspace_id, imageUrl, motionId, quality: "1080p", campaignId: campaign_id });
        if (!jobSetId) continue;
        const res = await pollJobUntilDone(workspace_id, jobSetId, { timeoutMs: 180000 });
        if (res.status === "completed" && res.outputUrls[0]) {
          const path = `broll/${workspace_id}/${campaign_id}_${i}.mp4`;
          await uploadFromUrl(path, res.outputUrls[0], "video/mp4");
          out.push({ image_url: imageUrl, video_url: await signedUrl(path), motion_id: motionId });
        }
      }
      return out;
    });

    await step.sendEvent("broll-completed", { name: "ad-tool/broll-completed", data: { workspace_id, campaign_id } });
    return { ok: true, clips };
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

    // Transcribe once; reused across formats.
    const transcript = await step.run("transcribe", async () => {
      if (!ctx.campaign?.audio_url) return [];
      try {
        const t = await transcribeWords(ctx.campaign.audio_url);
        return t.words;
      } catch {
        return [];
      }
    });

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

    // Gather generated media for this campaign's latest video rows.
    const media = await step.run("gather-media", async () => {
      const { data: vids } = await admin.from("ad_videos").select("talking_head_url, talking_head_segments_url, b_roll_urls").eq("campaign_id", campaign_id).limit(1).maybeSingle();
      const th: string[] = vids?.talking_head_segments_url?.length ? vids.talking_head_segments_url : vids?.talking_head_url ? [vids.talking_head_url] : [];
      const broll = Array.isArray(vids?.b_roll_urls) ? (vids!.b_roll_urls as Array<{ video_url: string; motion_id: string }>) : [];
      return { th, broll };
    });

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
        const props = buildCompositionProps({
          format: p.format,
          mediaKind: p.kind,
          lengthSec,
          style,
          vibeTags,
          transcript,
          talkingHeadSegments: media.th,
          brollClips: media.broll,
          credibility,
          ingredientImages: ctx.ingredientImages,
          heroImageUrl: (ctx.campaign as any)?.hero_image_url || undefined,
          staticHeadline: ctx.staticHeadline || undefined,
          staticTemplate: p.kind === "static" ? "shipping_label_brutalist" : undefined,
        });

        const ext = p.kind === "video" ? "mp4" : "jpg";
        const row: any = {
          workspace_id,
          campaign_id,
          format: p.format,
          media_kind: p.kind,
          format_variant_of_id: canonicalId,
          caption_style: style,
          duration_sec: lengthSec,
          status: "rendering",
          transcript_json: { words: transcript },
        };
        const { data: vrow } = await admin.from("ad_videos").insert(row).select("id").single();
        if (!canonicalId) canonicalId = vrow!.id;

        try {
          const tmp = `/tmp/ad_${campaign_id}_${p.format}_${p.kind}.${ext}`;
          const rendered = await renderAdFormat(props, tmp);
          const fs = await import("fs/promises");
          const buf = await fs.readFile(rendered.outputPath);
          const storagePath = `finals/${workspace_id}/${vrow!.id}.${ext}`;
          const { uploadBuffer, signedUrl: sign } = await import("@/lib/ad-storage");
          await uploadBuffer(storagePath, buf, p.kind === "video" ? "video/mp4" : "image/jpeg");
          const url = await sign(storagePath);
          await admin
            .from("ad_videos")
            .update(p.kind === "video" ? { final_mp4_url: url, status: "ready" } : { static_jpg_url: url, status: "ready" })
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

export const adToolFunctions = [
  adToolHeroRequested,
  adToolAudioRequested,
  adToolTalkingHeadRequested,
  adToolBrollRequested,
  adToolRenderRequested,
];

// keep imports used even if tree-shaken in some builds
void creditsToCents;
