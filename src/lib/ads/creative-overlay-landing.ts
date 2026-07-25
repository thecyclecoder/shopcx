/**
 * creative-overlay-landing — the LANDING TARGETS for Dahlia's overlay render path
 * (dahlia-competitor-ad-adaptation-overlay-render Phase 5). The ad detail page
 * (`/api/ads/campaigns/[id]`) reads copy from THREE places in this order:
 *   1. `readCopyVariants(campaignId)` — the temperature-banded pack in `ad_creative_copy_variants`;
 *   2. `product_ad_angles.metadata.copy_pack` — the 4×4 pack when the campaign carries an `angle_id`;
 *   3. `ad_campaigns.metadata.copy_pack` — the FALLBACK the `insertReadyCreative` broadcast
 *      writes onto the campaign row itself (the 102a218f held-draft fix).
 * Renders are re-signed from `ad_videos.meta.storage_path` for `format ∈ feed_4x5|stories_9x16|
 * right_column_1x1`. Adapted output written only to `ad_campaigns` is INVISIBLE — this module
 * enforces the write-back targets so the overlay path can't ship a phantom-ready creative.
 *
 * Pure planners + one write helper (`landOverlayCreativePack`). Composed from the existing
 * primitives:
 *   • [[creative-pack]] `planCreativePackInserts` — the ad_videos insert-body planner;
 *   • [[../ad-storage]] `uploadBuffer` / `signedUrl` — the `finals/{ws}/{videoId}.jpg` upload;
 *   • [[ad-copy-variants]] `writeCopyVariants` — the temperature-banded pack write.
 *
 * All writes carry compare-and-set guards (`.eq('id', ...).eq('workspace_id', ...)` +
 * `.select('id')` to assert exactly one row transitioned) per the coaching guardrail — a
 * cross-workspace / stale-row bleed on a landing write is a data-integrity defect.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import type { AuthorModeCopyVariant } from "./creative-agent";
import type { MetaCopyPack, PlacementFormat, RenderedPlacement } from "./creative-pack";
import { planCreativePackInserts } from "./creative-pack";
import { writeCopyVariants } from "./ad-copy-variants";
import { signedUrl as adStorageSignedUrl, uploadBuffer as adStorageUploadBuffer } from "@/lib/ad-storage";

type Admin = ReturnType<typeof createAdminClient>;

/** Storage seam so tests can inject a fake uploader/signer without touching the real Supabase
 *  bucket. Production callers omit — the module falls back to the real `ad-storage` helpers. */
export interface OverlayLandingStorage {
  uploadBuffer: (path: string, buffer: Buffer, contentType: string) => Promise<string>;
  signedUrl: (path: string) => Promise<string>;
}
const DEFAULT_STORAGE: OverlayLandingStorage = {
  uploadBuffer: adStorageUploadBuffer,
  signedUrl: adStorageSignedUrl,
};

/**
 * The three landing surfaces the detail page reads — enumerated as a stable constant so the
 * verification / logging paths can name them without a free-string. Grep-token for the
 * "copy lands in the angle copy_pack / copyVariants source" + "renders saved to ad_videos"
 * verification.
 */
export const OVERLAY_LANDING_TARGETS = {
  /** [ad_creative_copy_variants] — the temperature-banded pack, primary read source. */
  copyVariants: "ad_creative_copy_variants",
  /** [product_ad_angles.metadata.copy_pack] — 4×4 pack fallback the detail page reads. */
  angleCopyPack: "product_ad_angles.metadata.copy_pack",
  /** [ad_videos] rows with `meta.storage_path` — the re-signed render surface. */
  adVideos: "ad_videos",
} as const;

/** Storage path pattern the ad detail page re-signs from `meta.storage_path`. Named as a
 *  helper so any change (a bucket rename, a `finals` → `renders` shuffle) lands once and the
 *  landing-targets grep-token stays coherent. Grep-token: `finals/{ws}/{videoId}.{ext}`. */
export function overlayFinalsStoragePath(workspaceId: string, videoId: string, ext: "jpg" | "png"): string {
  return `finals/${workspaceId}/${videoId}.${ext}`;
}

/** Pure — the exact update body for `product_ad_angles.metadata.copy_pack`. Preserves the
 *  angle's existing `metadata` (provenance / concept tags / other keys) so a copy_pack write
 *  never clobbers the JSONB. */
export function buildAngleCopyPackUpdateBody(
  existingMetadata: Record<string, unknown> | null | undefined,
  copyPack: MetaCopyPack,
): { metadata: Record<string, unknown> } {
  const prior = existingMetadata && typeof existingMetadata === "object" ? existingMetadata : {};
  return { metadata: { ...prior, copy_pack: copyPack } };
}

// ── Land ────────────────────────────────────────────────────────────────────

export interface LandOverlayCreativePackOpts {
  workspaceId: string;
  /** The `ad_campaigns.id` this render pack + copy pack belong to. */
  campaignId: string;
  /** The campaign's `angle_id` — when set, `product_ad_angles.metadata.copy_pack` gets the
   *  4×4 pack (the primary detail-page fallback). Null skips the angle write (an author-mode
   *  fallback path where `insertReadyCreative` missed the angle insert — the campaign's own
   *  `metadata.copy_pack` broadcast still carries the pack). */
  angleId: string | null;
  /** feed_4x5 canonical render. */
  canonicalRender: RenderedPlacement;
  /** stories_9x16 + right_column_1x1 sibling renders. */
  siblingRenders: RenderedPlacement[];
  /** The 4×4 pack (`headlines[]` / `primaryTexts[]` / `description` / optional `frameworks[]`). */
  copyPack: MetaCopyPack;
  /** Optional temperature-banded variants (Dahlia's author-mode variations). When set, they are
   *  written via `writeCopyVariants` into `ad_creative_copy_variants` (the primary read source). */
  variants?: readonly AuthorModeCopyVariant[];
  /** Overrides `archetype` on the ad_videos meta blob. Default `'before_after'` (matches the
   *  legacy insertReadyCreative default). */
  archetype?: string;
  /** Overrides `generated_by` on the ad_videos meta blob. Default `'ad-creative-overlay'`. */
  generatedBy?: string;
  /** Storage seam — omit in production (falls back to the real `ad-storage` helpers). Tests
   *  inject a fake uploader/signer so the write-target assertions run without a real bucket. */
  storage?: OverlayLandingStorage;
}

export interface LandOverlayCreativePackResult {
  /** ID of the canonical `feed_4x5` ad_videos row. */
  canonicalAdVideoId: string;
  /** IDs of the sibling ad_videos rows in insert order (sibling formats: stories_9x16 + right_column_1x1). */
  siblingAdVideoIds: string[];
  /** True iff `product_ad_angles.metadata.copy_pack` was written (needs `angleId`). */
  angleCopyPackWritten: boolean;
  /** Number of temperature-banded variants written (0 when no `variants` supplied). */
  copyVariantsWritten: number;
}

/**
 * Land an overlay-path creative pack — copy + renders — where the ad detail page reads them.
 * Deterministic ordering:
 *   1. `product_ad_angles.metadata.copy_pack` (compare-and-set on angleId + workspaceId, so a
 *      cross-workspace or racing write can't clobber another workspace's angle).
 *   2. `ad_videos` canonical insert → upload buffer to `finals/{ws}/{videoId}.jpg` → sign URL →
 *      flip row to `status='ready'` + `meta.storage_path=...`.
 *   3. `ad_videos` siblings — same as canonical but with `format_variant_of_id = canonicalId`
 *      (the same-psychology invariant: these three rows are ONE concept, expressed in the DB).
 *   4. `ad_creative_copy_variants` — the temperature-banded pack via `writeCopyVariants` (only
 *      when `opts.variants` is supplied).
 *
 * Every write is a compare-and-set on `id + workspace_id` (or the equivalent upsert-conflict
 * on the copy_variants unique key) so a stale row / cross-workspace bleed can't land here.
 * Returns the ids the caller may audit — `campaignId` remains the parent join.
 */
export async function landOverlayCreativePack(
  admin: Admin,
  opts: LandOverlayCreativePackOpts,
): Promise<LandOverlayCreativePackResult> {
  const archetype = opts.archetype ?? "before_after";
  const generatedBy = opts.generatedBy ?? "ad-creative-overlay";
  const storage = opts.storage ?? DEFAULT_STORAGE;

  const plan = planCreativePackInserts({
    workspaceId: opts.workspaceId,
    campaignId: opts.campaignId,
    canonicalRender: opts.canonicalRender,
    siblingRenders: opts.siblingRenders,
    copyPack: opts.copyPack,
    archetype,
    generatedBy,
  });

  // ── 1. Angle copy_pack (primary detail-page fallback when copyVariants is empty) ──────────
  let angleCopyPackWritten = false;
  if (opts.angleId) {
    // Read the existing metadata so we can splat-preserve it (provenance / concept tags /
    // other keys must survive a copy_pack write — the JSONB is not owned by this module).
    const { data: angleRow } = await admin
      .from("product_ad_angles")
      .select("metadata")
      .eq("id", opts.angleId)
      .eq("workspace_id", opts.workspaceId)
      .single();
    const priorMetadata = ((angleRow as { metadata?: Record<string, unknown> | null } | null)?.metadata) ?? null;
    const body = buildAngleCopyPackUpdateBody(priorMetadata, opts.copyPack);
    // Compare-and-set: `.eq('id').eq('workspace_id')` + `.select('id')` proves exactly one
    // row transitioned. A zero-row `data` here means the angle was concurrently deleted /
    // moved workspace — surface it (`angleCopyPackWritten=false`) rather than silently
    // treat the landing as complete.
    const { data: updated, error } = await admin
      .from("product_ad_angles")
      .update(body)
      .eq("id", opts.angleId)
      .eq("workspace_id", opts.workspaceId)
      .select("id");
    if (error) {
      throw new Error(`landOverlayCreativePack: angle copy_pack write failed (angle_id=${opts.angleId}): ${error.message}`);
    }
    angleCopyPackWritten = (updated ?? []).length === 1;
  }

  // ── 2. Canonical ad_videos row ────────────────────────────────────────────────────────────
  const canonicalAdVideoId = await insertOverlayAdVideo(
    admin,
    opts.workspaceId,
    plan.canonical,
    opts.canonicalRender,
    null,
    storage,
  );

  // ── 3. Siblings ad_videos rows (format_variant_of_id → canonical) ─────────────────────────
  const siblingAdVideoIds: string[] = [];
  for (let i = 0; i < plan.siblings.length; i++) {
    const sid = await insertOverlayAdVideo(
      admin,
      opts.workspaceId,
      plan.siblings[i],
      opts.siblingRenders[i],
      canonicalAdVideoId,
      storage,
    );
    siblingAdVideoIds.push(sid);
  }

  // ── 4. Temperature-banded variants (primary read source) ──────────────────────────────────
  let copyVariantsWritten = 0;
  if (opts.variants && opts.variants.length) {
    const res = await writeCopyVariants(admin, {
      adCampaignId: opts.campaignId,
      workspaceId: opts.workspaceId,
      variants: opts.variants,
    });
    copyVariantsWritten = res.inserted;
  }

  return { canonicalAdVideoId, siblingAdVideoIds, angleCopyPackWritten, copyVariantsWritten };
}

/**
 * Insert ONE overlay placement render — mirrors the shape `insertOnePlacementRender` uses in
 * [[creative-agent]] but scoped to the overlay path (its own `meta.generated_by` value so the
 * downstream telemetry can distinguish overlay-path landings from legacy ones). Compare-and-
 * set on the followup update: `.eq('id', videoId).eq('workspace_id', workspaceId).select('id')`
 * so a racing delete / cross-workspace bleed can't flip the wrong row to `ready`.
 */
async function insertOverlayAdVideo(
  admin: Admin,
  workspaceId: string,
  insertBody: { workspace_id: string; campaign_id: string; format: PlacementFormat; media_kind: string; status: string; meta: { archetype: string; generated_by: string } },
  render: RenderedPlacement,
  variantOfId: string | null,
  storage: OverlayLandingStorage,
): Promise<string> {
  const { data: vrow, error: insertErr } = await admin
    .from("ad_videos")
    .insert({ ...insertBody, format_variant_of_id: variantOfId })
    .select("id")
    .single();
  if (insertErr || !vrow) {
    throw new Error(`landOverlayCreativePack: ad_videos insert failed (format=${insertBody.format}): ${insertErr?.message ?? "no row returned"}`);
  }
  const videoId = (vrow as { id: string }).id;
  const ext: "jpg" | "png" = render.mimeType.includes("png") ? "png" : "jpg";
  const storagePath = overlayFinalsStoragePath(workspaceId, videoId, ext);
  await storage.uploadBuffer(storagePath, render.buffer, render.mimeType);
  const url = await storage.signedUrl(storagePath);
  const { data: updated, error: updateErr } = await admin
    .from("ad_videos")
    .update({
      static_jpg_url: url,
      status: "ready",
      meta: { ...insertBody.meta, storage_path: storagePath },
    })
    .eq("id", videoId)
    .eq("workspace_id", workspaceId)
    .select("id");
  if (updateErr) {
    throw new Error(`landOverlayCreativePack: ad_videos update failed (video_id=${videoId}): ${updateErr.message}`);
  }
  if ((updated ?? []).length !== 1) {
    throw new Error(`landOverlayCreativePack: ad_videos compare-and-set matched ${(updated ?? []).length} rows for video_id=${videoId} (expected 1)`);
  }
  return videoId;
}
