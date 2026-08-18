/**
 * regenerate-existing-format — the surgical in-place edit path for a CEO-review render note.
 *
 * ceo-feedback-render-edits-the-existing-ad-format-in-place-not-a-new-whole-pack-ad Phase 1. When
 * the CEO leaves a per-format comment on a rendered ad ("make the product bigger", "change the
 * 'free tote' badge to 'Free Shipping with Subscribe and Save'"), the ad-review-feedback router
 * enqueues an `ad-creative` `agent_jobs` row whose instructions carry `ad_campaign_id`, `format`,
 * and `revise_reason`. THIS module runs on that instructions shape: it regenerates ONLY the named
 * format's image on the EXISTING [[ad_campaigns]] row via [[ad_videos]] `campaign_id`+`format`
 * lookup, threading the CEO note into the render prompt via `generateCreative`'s
 * `ceoReviseReason` (see [[./creative-generate]] `buildPrompt`), then swaps the `static_jpg_url`
 * + `meta.storage_path` on that ONE `ad_videos` row in place. The other formats + the copy are
 * left untouched, and NO new `ad_campaigns` row is ever inserted — that's the whole value of the
 * feedback loop, and the guard [[../../../scripts/builder-worker.ts]] `runAdCreativeJob`
 * branches on to keep a fresh whole-pack generation from clobbering the CEO's actual edit.
 *
 * Pure w.r.t. Supabase — every write goes through the `admin` client. Dependency-injectable so a
 * unit test can pin the branch decision + writes without hitting Nano Banana or Supabase Storage.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { uploadBuffer, signedUrl } from "@/lib/ad-storage";
import { generateCreative } from "@/lib/ads/creative-generate";
import { buildCreativeBrief, type ScoredAngle } from "@/lib/ads/creative-brief";
import { getProductIntelligence } from "@/lib/product-intelligence";
import { PLACEMENT_ASPECT, type PlacementFormat } from "@/lib/ads/creative-pack";

type Admin = ReturnType<typeof createAdminClient>;

export interface RegenerateExistingFormatInput {
  workspaceId: string;
  adCampaignId: string;
  format: PlacementFormat;
  /** The CEO's per-format comment from `ad_review_feedback.packet.entries[].comment`, routed via
   *  the ad-review-feedback router as `instructions.revise_reason`. Trimmed + threaded into the
   *  render prompt via [[./creative-generate]] `buildPrompt` (see the `CEO EDIT` clause). */
  ceoReviseReason: string;
}

export type RegenerateExistingFormatResult =
  | {
      ok: true;
      /** The [[ad_videos]] row id whose `static_jpg_url` + `meta.storage_path` were rewritten. */
      adVideoId: string;
      storagePath: string;
      signedUrl: string;
      /** The Nano Banana prompt that produced the new bytes. Kept on the result so a caller can
       *  log it or a test can assert the CEO clause landed in it. */
      prompt: string;
    }
  | { ok: false; reason: string };

/** Dependency-injectable seams so a unit test can pin the branch decision + writes without
 *  hitting Nano Banana or Supabase Storage. Every seam falls back to the production impl when
 *  omitted, so the caller's default form matches today's behavior byte-for-byte. */
export interface RegenerateExistingFormatDeps {
  /** Render one static from the reconstructed brief at the target aspect ratio. Defaults to the
   *  production [[./creative-generate]] `generateCreative` (Nano Banana Pro). */
  generate?: typeof generateCreative;
  /** Upload the rendered bytes to Supabase Storage. Defaults to [[../ad-storage]] `uploadBuffer`. */
  upload?: typeof uploadBuffer;
  /** Sign the storage path for the ad_videos.static_jpg_url column. Defaults to
   *  [[../ad-storage]] `signedUrl`. */
  sign?: typeof signedUrl;
  /** Load the fully-backed brief for the campaign's product + reconstructed angle. Defaults to the
   *  production [[./creative-brief]] `buildCreativeBrief`. */
  buildBrief?: typeof buildCreativeBrief;
  /** Load the [[../product-intelligence]] snapshot. Defaults to
   *  [[../product-intelligence]] `getProductIntelligence`. */
  loadPi?: typeof getProductIntelligence;
}

/** Pure — reconstruct a minimal [[./creative-brief]] `ScoredAngle` from a persisted
 *  `product_ad_angles` row so `buildCreativeBrief` can rebuild the same brief the fresh-pack
 *  path built. Only the fields `buildCreativeBrief` actually reads survive (hook, source,
 *  leadBenefit, `raw` — the row-carrier for `pi.reviews.byClaim`) — everything else is filled
 *  with a safe neutral so the caller's shape matches the type but does not fabricate a score.
 *  A test can drive this in isolation.
 *
 *  Exported so the branch handler + a unit test can pin the mapping. */
export function reconstructAngleFromRow(
  row: {
    hook_one_liner?: string | null;
    lead_benefit_anchor?: string | null;
    hook_slug?: string | null;
  } | null,
): ScoredAngle {
  return {
    hook: (row?.hook_one_liner || "").trim(),
    source: "ad_angle",
    leadBenefit: (row?.lead_benefit_anchor || "").trim(),
    // Neutral scores — this is an EDIT of an already-shipped creative, not a re-ranking. The
    // scores never reach the render prompt (buildPrompt reads only the copy fields).
    acquisitionPower: 5,
    retentionTruth: 5,
    commodity: false,
    hasRealPhoto: false,
    reasons: ["reconstructed for ceo-review-feedback in-place regen"],
    raw: (row ?? undefined) as Record<string, unknown> | undefined,
    conceptTags: null,
  };
}

/** Sentinel header for the in-place edit clause. Exported so a test can pin it and the render
 *  provenance can be recognised later. */
export const IN_PLACE_EDIT_HEADER = "EDIT THE EXISTING AD (apply the change, redesign nothing):";

/**
 * PURE — compose the prompt for a surgical in-place edit by REPLAYING the original render prompt
 * with the owner's change layered on top.
 *
 * Why replay instead of rebuild (CEO 2026-08-18): the rebuild path derives a fresh brief via
 * `buildCreativeBrief(pi, angle)` and then renders from it, which silently drops every rail the
 * ORIGINAL render carried but the rebuild doesn't know about — the cold-offer strip, the owner's
 * `authorNotes`, the composition-transfer reference that made it an imitation, and the treatment
 * steer. Campaign c7fe4815 came back from an edit as a generic, offer-laden ad that no longer
 * resembled the competitor structure it was built to mimic. The original prompt already encodes
 * all of it, so replaying it preserves them by construction rather than re-deriving them and
 * getting it wrong.
 *
 * The current rendered image is handed to the model as the FIRST image, so "reproduce this and
 * change only X" is anchored to actual pixels rather than to a description of them.
 */
export function buildInPlaceEditPrompt(originalPrompt: string, reviseReason: string): string {
  return [
    `${IN_PLACE_EDIT_HEADER} the FIRST image is the CURRENT, finished version of THIS EXACT AD. Reproduce it faithfully — same layout, same composition, same headline and sub-headline wording, same colours, same product placement, same proof bar — and apply ONLY the change described below. Do not redesign, do not re-lay-out, do not add elements that are not already there, and do not "improve" anything you were not asked to change.`,
    `THE CHANGE TO APPLY: ${reviseReason}`,
    `Everything not named in that change must come out pixel-faithful to the first image.`,
    ``,
    `CONTEXT ONLY — the prompt the current version was rendered from is reproduced below so you keep its rules (audience, offer treatment, source structure, product fidelity). It is NOT a brief to re-execute from scratch; the first image is the source of truth for what this ad already looks like.`,
    originalPrompt,
  ].join("\n\n");
}

/**
 * The main entry — surgical in-place regen of ONE placement format on an EXISTING campaign.
 *
 * Guards (all hard-required — the whole point of the spec):
 *   1. If the campaign row can't be loaded → `no_campaign`.
 *   2. If the `ad_videos` row for `{ campaign_id, format }` isn't there → `no_ad_video_for_format`
 *      (never insert a new one — the format isn't part of this campaign's placement pack).
 *   3. The upload path REUSES the existing `ad_videos.id` (`finals/{ws}/{video_id}.{ext}`) so we
 *      overwrite the stored blob in place — no orphan files, no stale sibling.
 *   4. NEVER call `.from('ad_campaigns').insert(...)` — that's the fresh-pack path this replaces.
 *
 * On success we bump `ad_campaigns.updated_at` so an ops-side reader can see the surgical edit
 * landed on THIS row (the CEO's exact observation from the source spec: the original updated_at
 * being unchanged is how she noticed her note had been ignored).
 */
export async function regenerateExistingFormat(
  admin: Admin,
  input: RegenerateExistingFormatInput,
  deps: RegenerateExistingFormatDeps = {},
): Promise<RegenerateExistingFormatResult> {
  const { workspaceId, adCampaignId, format, ceoReviseReason } = input;

  const trimmedReason = ceoReviseReason?.trim() ?? "";
  if (!trimmedReason) {
    return { ok: false, reason: "empty_ceo_revise_reason" };
  }
  if (!PLACEMENT_ASPECT[format]) {
    return { ok: false, reason: `unknown_format:${format}` };
  }

  // 1) Load the campaign row — abort if it isn't ours (workspace scope + id).
  const { data: campaign, error: campErr } = await admin
    .from("ad_campaigns")
    .select("id, workspace_id, product_id, angle_id, audience_temperature")
    .eq("workspace_id", workspaceId)
    .eq("id", adCampaignId)
    .maybeSingle();
  if (campErr || !campaign) {
    return { ok: false, reason: campErr?.message ? `no_campaign:${campErr.message}` : "no_campaign" };
  }
  const productId = (campaign as { product_id?: string | null }).product_id ?? null;
  const angleId = (campaign as { angle_id?: string | null }).angle_id ?? null;
  if (!productId) {
    return { ok: false, reason: "no_product_id_on_campaign" };
  }

  // 2) Locate the ad_videos row for THIS campaign + THIS format — never insert a new one.
  const { data: video, error: vidErr } = await admin
    .from("ad_videos")
    .select("id, static_jpg_url, meta")
    .eq("workspace_id", workspaceId)
    .eq("campaign_id", adCampaignId)
    .eq("format", format)
    .maybeSingle();
  if (vidErr || !video) {
    return { ok: false, reason: vidErr?.message ? `no_ad_video_for_format:${vidErr.message}` : "no_ad_video_for_format" };
  }
  const adVideoId = (video as { id: string }).id;
  // Hoisted: the replay path (step 4) reads the persisted per-placement render prompt out of this
  // row's meta, and hands the ad's CURRENT image to the model as the edit anchor.
  const existingMeta = ((video as { meta?: Record<string, unknown> | null }).meta ?? {}) as Record<string, unknown>;
  const currentImageUrl = (() => {
    const u = (video as { static_jpg_url?: unknown }).static_jpg_url;
    return typeof u === "string" && /^https?:/.test(u) ? u : undefined;
  })();

  // 3) Reconstruct the CreativeBrief so the render carries the campaign's real angle + proof.
  const loadPi = deps.loadPi ?? getProductIntelligence;
  const buildBrief = deps.buildBrief ?? buildCreativeBrief;
  const pi = await loadPi(admin, workspaceId, productId);

  let angleRow: {
    hook_one_liner?: string | null;
    lead_benefit_anchor?: string | null;
    hook_slug?: string | null;
  } | null = null;
  if (angleId) {
    const { data: aRow } = await admin
      .from("product_ad_angles")
      .select("hook_one_liner, lead_benefit_anchor, hook_slug")
      .eq("workspace_id", workspaceId)
      .eq("id", angleId)
      .maybeSingle();
    angleRow = (aRow as typeof angleRow) ?? null;
  }
  const angle = reconstructAngleFromRow(angleRow);
  const brief = await buildBrief(pi, angle);

  // ⭐ COLD RAIL ON THE REGEN (CEO 2026-08-18). The fresh-pack path strips the offer off a cold
  // creative's IMAGE before rendering — `brief.offer = imageOfferForAudience(angle, brief.offer)`
  // in [[./creative-agent]] `stockProduct`, added after the 2026-07-17 run put a discount on a
  // cold static. This in-place regen never inherited that line, so a CEO edit re-rendered a cold
  // ad WITH the offer: campaign c7fe4815 ("steaming mug pouch gut hook", audience_temperature
  // 'cold') came back carrying "Up to 34% off + free shipping" and "$1.76/serving vs a $4-8
  // coffee/latte" baked into the pixels.
  //
  // We key off the PERSISTED `ad_campaigns.audience_temperature`, not the reconstructed angle:
  // `reconstructAngleFromRow` hardcodes `source:'ad_angle'`, so `resolveAudienceTemperature`
  // can never classify a rebuilt angle as cold and `imageOfferForAudience` would pass the offer
  // straight through. The column is what the creative was actually authored for.
  const campaignTemperature = (campaign as { audience_temperature?: string | null }).audience_temperature ?? null;
  if (campaignTemperature === "cold") brief.offer = null;

  // 4) Render ONE format at its declared aspect ratio.
  //
  // PREFERRED PATH (CEO 2026-08-18): replay the ORIGINAL prompt for this placement with the edit
  // layered on, anchored to the current pixels. The rebuilt `brief` above cannot carry the rails
  // the original render had — the owner's authorNotes, the composition-transfer reference, the
  // treatment steer — so re-deriving from it turns a surgical edit into a fresh generic ad
  // (campaign c7fe4815, 2026-08-18). Replaying keeps them by construction.
  //
  // Gated on `prompt_truncated`: the persisted prompt is capped at write time, and replaying a
  // string cut mid-sentence would be worse than rebuilding. Falls back to the rebuild path when
  // the prompt is missing (pre-Phase-4 rows) or truncated — with the cold rail above still applied.
  const priorRender = (existingMeta as { render?: { prompt?: unknown; prompt_truncated?: unknown } }).render;
  const priorPrompt = typeof priorRender?.prompt === "string" ? priorRender.prompt.trim() : "";
  const priorUsable = priorPrompt.length > 0 && priorRender?.prompt_truncated !== true;
  const overridePrompt = priorUsable ? buildInPlaceEditPrompt(priorPrompt, trimmedReason) : undefined;

  const generate = deps.generate ?? generateCreative;
  let render: Awaited<ReturnType<typeof generateCreative>>;
  try {
    render = await generate(workspaceId, brief, {
      aspectRatio: PLACEMENT_ASPECT[format],
      ceoReviseReason: trimmedReason,
      ...(overridePrompt
        ? {
            overridePrompt,
            // Hand the model the ad as it exists today as the FIRST image, so "reproduce this and
            // change only X" is anchored to pixels rather than to a description of them.
            ...(currentImageUrl ? { canonicalRenderDataUrl: currentImageUrl } : {}),
          }
        : {}),
    });
  } catch (err) {
    return { ok: false, reason: `render_failed:${errText(err)}` };
  }

  // 5) Overwrite the existing ad_videos row's stored blob + refresh its signed URL. Reusing the
  //    video_id in the storage path means the previous bytes are replaced in place (uploadBuffer
  //    uses upsert:true), so there's no orphan file to sweep and no stale sibling to leak.
  const upload = deps.upload ?? uploadBuffer;
  const sign = deps.sign ?? signedUrl;
  const ext = render.mimeType.includes("png") ? "png" : "jpg";
  const storagePath = `finals/${workspaceId}/${adVideoId}.${ext}`;
  try {
    await upload(storagePath, render.buffer, render.mimeType);
  } catch (err) {
    return { ok: false, reason: `upload_failed:${errText(err)}` };
  }

  let url: string;
  try {
    url = await sign(storagePath);
  } catch (err) {
    return { ok: false, reason: `sign_failed:${errText(err)}` };
  }

  // Merge storage_path into meta rather than overwriting the whole object — the row may carry an
  // archetype / generated_by we want to preserve.
  const nextMeta = { ...existingMeta, storage_path: storagePath };
  const { error: updErr } = await admin
    .from("ad_videos")
    .update({ static_jpg_url: url, meta: nextMeta, status: "ready" })
    .eq("workspace_id", workspaceId)
    .eq("id", adVideoId);
  if (updErr) {
    return { ok: false, reason: `ad_videos_update_failed:${updErr.message}` };
  }

  // Bump ad_campaigns.updated_at so the CEO can see her note landed on THIS row (her exact
  // 'the original updated_at is unchanged' observation is what drove this spec). No status flip,
  // no insert — the campaign stays put.
  await admin
    .from("ad_campaigns")
    .update({ updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("id", adCampaignId);

  return { ok: true, adVideoId, storagePath, signedUrl: url, prompt: render.prompt };
}
