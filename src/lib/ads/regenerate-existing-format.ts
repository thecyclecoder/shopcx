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
    .select("id, workspace_id, product_id, angle_id")
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

  // 4) Render ONE format at its declared aspect ratio, threading the CEO note into the prompt.
  const generate = deps.generate ?? generateCreative;
  let render: Awaited<ReturnType<typeof generateCreative>>;
  try {
    render = await generate(workspaceId, brief, {
      aspectRatio: PLACEMENT_ASPECT[format],
      ceoReviseReason: trimmedReason,
    });
  } catch (err) {
    return { ok: false, reason: `render_failed:${err instanceof Error ? err.message : String(err)}` };
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
    return { ok: false, reason: `upload_failed:${err instanceof Error ? err.message : String(err)}` };
  }

  let url: string;
  try {
    url = await sign(storagePath);
  } catch (err) {
    return { ok: false, reason: `sign_failed:${err instanceof Error ? err.message : String(err)}` };
  }

  // Merge storage_path into meta rather than overwriting the whole object — the row may carry an
  // archetype / generated_by we want to preserve.
  const existingMeta = ((video as { meta?: Record<string, unknown> | null }).meta ?? {}) as Record<string, unknown>;
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
