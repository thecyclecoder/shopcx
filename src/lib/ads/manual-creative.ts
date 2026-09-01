/**
 * manual-creative — the chokepoint for landing a HAND-PRODUCED creative into the ad
 * library so Bianca's `listReadyToTest` can pick it up.
 *
 * Why this exists: `insertReadyCreative` ([[./creative-agent]]) is module-private and
 * shaped for Dahlia's autonomous static lane — it expects a `product_ad_angles` row, v3
 * attribution stamps (`creative_theme` / `angle_palette_id` / `headline_pattern_id` /
 * `creative_combination_id`) and a Max copy-QC verdict. A creative produced outside that
 * lane (the podcast-interview video ads, a founder-shot clip, a one-off render) has none
 * of those, so before this SDK the only way to shelve one was a raw
 * `.from("ad_campaigns").insert()` — exactly the hand-rolled write CLAUDE.md forbids
 * ("Raw `.from(...)` with no SDK → STOP").
 *
 * The contract mirrors the render path in [[../inngest/ad-tool]] (`render-formats`) so a
 * manually-landed row is byte-comparable to a pipeline-rendered one:
 *   ad_campaigns  status='ready' · landing_url · audience_temperature · author_self_score
 *                 · headline / primary_text / description · metadata.copy_pack
 *   ad_videos     status='ready' · final_mp4_url (signed) · meta.storage_path
 *                 (`finals/{workspace_id}/{ad_videos.id}.mp4`)
 *
 * `max_qc_eligible` is left NULL — Max never ran on a hand-made creative. Bianca's
 * `.not("max_qc_eligible","is",false)` filter treats NULL the same as TRUE, so the row is
 * postable without pretending a QC pass happened ([[./ready-to-test]]).
 *
 * North-star note: the gate REFUSES rather than writing a degraded row. A creative that
 * would publish as a <4-copy ad, breach a Meta cap, or ship a destination URL the
 * attribution sensor cannot resolve is a rail — and hitting a rail means stop, not execute
 * (CLAUDE.md § North star). Nothing here escalates on its own; the caller decides.
 */
import { CREATIVE_PACK_MIN, type MetaCopyPack } from "@/lib/ads/creative-pack";
import { META_CAPS, type AdFormat, type CaptionStyle } from "@/lib/ad-tool-config";
import { hasScentMatchParams } from "@/lib/advertorial-pages";
import { AUTHOR_SELF_SCORE_FLOOR, type AuthorSelfScore } from "@/lib/ads/creative-agent";
import { uploadBuffer, signedUrl } from "@/lib/ad-storage";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** A single rendered output to shelve. `buffer` is the finished media bytes — the SDK owns
 *  the storage path so it always matches the render path's `finals/{ws}/{id}.{ext}` shape. */
export interface ManualCreativeMedia {
  buffer: Buffer;
  format: AdFormat;
  /** Rounded to a whole second on write, matching the render path. */
  durationSec: number;
  captionStyle?: CaptionStyle;
  /** Optional word-level timings, persisted to `ad_videos.transcript_json` exactly as the
   *  render path does (`{ words: [...] }`) so the detail page can render captions. */
  transcriptWords?: { word: string; start: number; end: number }[];
}

export interface LandManualCreativeArgs {
  workspaceId: string;
  productId: string;
  /** Human name for the ad-library row (shown in the studio + Bianca's list). */
  name: string;
  /** Destination URL. MUST already carry scent-match params — see the gate. */
  landingUrl: string;
  audienceTemperature: "cold" | "warm" | "hot";
  copyPack: MetaCopyPack;
  /** The author's rubric self-score ([[./copy-rubric]] `scoreConversionPsychology`).
   *  Gated against `AUTHOR_SELF_SCORE_FLOOR` when present; NULL skips the floor check
   *  (a deliberately unscored creative still lands, matching deterministic mode). */
  selfScore?: AuthorSelfScore | null;
  media: ManualCreativeMedia;
}

/** Every deterministic refusal the gate can name. Kept as a union so callers can branch
 *  (and so the test suite asserts on a token, never a prose string). */
export type ManualCreativeRefusal =
  | "headlines_below_min"
  | "primary_texts_below_min"
  | "headline_over_cap"
  | "primary_text_over_cap"
  | "description_over_cap"
  | "missing_scent_match_params"
  | "empty_media"
  | "self_score_below_floor";

export interface ManualCreativeGateResult {
  ok: boolean;
  reason?: ManualCreativeRefusal;
  /** Human-readable specifics (which headline, what length vs cap). Never a control value. */
  detail?: string;
}

/**
 * PURE pre-write gate. Every rail here is a reason the row would publish as a DEGRADED ad,
 * so all of them refuse before anything is written or uploaded.
 *
 * Ordering is first-match and deliberate — pack completeness before caps before URL before
 * media before score — so a caller fixing refusals walks the same sequence every time.
 */
export function evaluateManualCreativeGate(args: LandManualCreativeArgs): ManualCreativeGateResult {
  const { landingUrl, media } = args;

  const copyRails = evaluateManualCopyRails(args);
  if (!copyRails.ok) return copyRails;

  // Without ?angle=&variant= the attribution sensor buckets clicks to (unresolved) and
  // per-creative ROAS goes dark — see [[../../docs/brain/lifecycles/ad-publish]].
  if (!landingUrl || !hasScentMatchParams(landingUrl)) {
    return { ok: false, reason: "missing_scent_match_params", detail: landingUrl || "(empty)" };
  }

  if (!media?.buffer?.length) return { ok: false, reason: "empty_media" };

  return { ok: true };
}

/**
 * PURE copy-only rails, shared by the land gate and `updateManualCreativeCopy`. Split out so a
 * copy revision on an already-landed creative is held to the EXACT same pack-completeness, Meta
 * cap, and self-score bar as the original insert — a revision can otherwise quietly degrade a
 * postable row (drop below 4 variations, breach a cap) with no gate in its path.
 */
export function evaluateManualCopyRails(args: {
  copyPack: MetaCopyPack;
  selfScore?: AuthorSelfScore | null;
}): ManualCreativeGateResult {
  const { copyPack, selfScore } = args;

  if ((copyPack.headlines?.length ?? 0) < CREATIVE_PACK_MIN.headlines) {
    return { ok: false, reason: "headlines_below_min", detail: `${copyPack.headlines?.length ?? 0} < ${CREATIVE_PACK_MIN.headlines}` };
  }
  if ((copyPack.primaryTexts?.length ?? 0) < CREATIVE_PACK_MIN.primaryTexts) {
    return { ok: false, reason: "primary_texts_below_min", detail: `${copyPack.primaryTexts?.length ?? 0} < ${CREATIVE_PACK_MIN.primaryTexts}` };
  }

  // Meta hard caps — a breach is rejected by Graph at creative-create, so catch it here.
  const longHeadline = copyPack.headlines.find((h) => h.length > META_CAPS.headline);
  if (longHeadline) {
    return { ok: false, reason: "headline_over_cap", detail: `${longHeadline.length} > ${META_CAPS.headline}: "${longHeadline}"` };
  }
  const longPrimary = copyPack.primaryTexts.find((p) => p.length > META_CAPS.primary_text);
  if (longPrimary) {
    return { ok: false, reason: "primary_text_over_cap", detail: `${longPrimary.length} > ${META_CAPS.primary_text}` };
  }
  if ((copyPack.description?.length ?? 0) > META_CAPS.description) {
    return { ok: false, reason: "description_over_cap", detail: `${copyPack.description.length} > ${META_CAPS.description}` };
  }

  if (selfScore && selfScore.total < AUTHOR_SELF_SCORE_FLOOR) {
    return { ok: false, reason: "self_score_below_floor", detail: `total=${selfScore.total}, floor=${AUTHOR_SELF_SCORE_FLOOR}` };
  }

  return { ok: true };
}

export type LandManualCreativeResult =
  | { kind: "ok"; campaignId: string; videoId: string; storagePath: string; finalUrl: string }
  | { kind: "refused"; reason: ManualCreativeRefusal; detail?: string }
  | { kind: "failed"; detail: string };

/**
 * Land a hand-produced creative as a postable ad-library row.
 *
 * Write order matches the render path so a crash mid-flight is recoverable, never silently
 * postable: the campaign lands `status='draft'` and the video `status='rendering'` FIRST,
 * the bytes upload, and only then are both promoted to `ready`. A failure between those
 * points leaves a visible draft with a stamped error rather than a ready row pointing at
 * media that was never stored.
 */
export async function landManualCreative(
  admin: Admin,
  args: LandManualCreativeArgs,
): Promise<LandManualCreativeResult> {
  const gate = evaluateManualCreativeGate(args);
  if (!gate.ok) return { kind: "refused", reason: gate.reason!, detail: gate.detail };

  const { workspaceId, productId, name, landingUrl, audienceTemperature, copyPack, selfScore, media } = args;

  const { data: campaign, error: cErr } = await admin
    .from("ad_campaigns")
    .insert({
      workspace_id: workspaceId,
      product_id: productId,
      name,
      status: "draft", // promoted to 'ready' only after the media is stored
      landing_url: landingUrl,
      audience_temperature: audienceTemperature,
      author_self_score: selfScore ?? null,
      max_qc_eligible: null, // Max never ran — NULL reads as postable, TRUE would be a lie
      caption_style: media.captionStyle ?? "hormozi_yellow",
      length_sec: Math.round(media.durationSec),
      headline: copyPack.headlines[0],
      primary_text: copyPack.primaryTexts[0],
      description: copyPack.description,
      metadata: { copy_pack: copyPack },
    })
    .select("id")
    .single();
  if (cErr || !campaign) return { kind: "failed", detail: `campaign_insert: ${cErr?.message ?? "no row"}` };

  const { data: video, error: vErr } = await admin
    .from("ad_videos")
    .insert({
      workspace_id: workspaceId,
      campaign_id: campaign.id,
      format: media.format,
      media_kind: "video",
      caption_style: media.captionStyle ?? "hormozi_yellow",
      duration_sec: Math.round(media.durationSec),
      status: "rendering",
      transcript_json: media.transcriptWords ? { words: media.transcriptWords } : null,
    })
    .select("id")
    .single();
  if (vErr || !video) return { kind: "failed", detail: `video_insert: ${vErr?.message ?? "no row"}` };

  const storagePath = `finals/${workspaceId}/${video.id}.mp4`;
  let finalUrl: string;
  try {
    await uploadBuffer(storagePath, media.buffer, "video/mp4");
    finalUrl = await signedUrl(storagePath);
  } catch (err) {
    const detail = String((err as Error)?.message ?? err);
    await admin.from("ad_videos").update({ status: "failed", meta: { error: detail } }).eq("id", video.id);
    return { kind: "failed", detail: `upload: ${detail}` };
  }

  await admin
    .from("ad_videos")
    .update({ final_mp4_url: finalUrl, status: "ready", meta: { storage_path: storagePath } })
    .eq("id", video.id);
  await admin.from("ad_campaigns").update({ status: "ready" }).eq("id", campaign.id);

  return { kind: "ok", campaignId: campaign.id, videoId: video.id, storagePath, finalUrl };
}

export type UpdateManualCreativeCopyResult =
  | { kind: "ok"; adCampaignId: string; headlines: number; primaryTexts: number }
  | { kind: "refused"; reason: ManualCreativeRefusal; detail?: string }
  | { kind: "failed"; detail: string };

/**
 * Revise the copy on an already-landed manual creative, in place.
 *
 * Writes the SAME three surfaces `landManualCreative` does — `metadata.copy_pack` (the full
 * pack the publisher reads as its third fallback when the campaign carries no `angle_id`) plus
 * the denormalised slot-0 `headline` / `primary_text` / `description` columns the ad detail page
 * renders. Keeping them in lockstep matters: a revision that updated only the pack would leave
 * the detail page showing stale copy while Meta served the new text.
 *
 * Held to the same copy rails as the original insert via `evaluateManualCopyRails`, so a
 * revision cannot quietly drop a postable row below 4 variations or past a Meta cap. Media,
 * landing URL, and publish state are untouched — this is copy only.
 */
export async function updateManualCreativeCopy(
  admin: Admin,
  opts: {
    workspaceId: string;
    adCampaignId: string;
    copyPack: MetaCopyPack;
    selfScore?: AuthorSelfScore | null;
  },
): Promise<UpdateManualCreativeCopyResult> {
  const gate = evaluateManualCopyRails(opts);
  if (!gate.ok) return { kind: "refused", reason: gate.reason!, detail: gate.detail };

  const { workspaceId, adCampaignId, copyPack, selfScore } = opts;
  const patch: Record<string, unknown> = {
    headline: copyPack.headlines[0],
    primary_text: copyPack.primaryTexts[0],
    description: copyPack.description,
    metadata: { copy_pack: copyPack },
  };
  if (selfScore !== undefined) patch.author_self_score = selfScore ?? null;

  const { data, error } = await admin
    .from("ad_campaigns")
    .update(patch)
    .eq("id", adCampaignId)
    .eq("workspace_id", workspaceId)
    .select("id")
    .maybeSingle();
  if (error) return { kind: "failed", detail: `campaign_update: ${error.message}` };
  if (!data) return { kind: "failed", detail: "campaign_update: no matching row (wrong id or workspace)" };

  return {
    kind: "ok",
    adCampaignId: data.id,
    headlines: copyPack.headlines.length,
    primaryTexts: copyPack.primaryTexts.length,
  };
}
