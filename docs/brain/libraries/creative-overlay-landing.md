# `src/lib/ads/creative-overlay-landing.ts`

The **LANDING TARGETS** for Dahlia's overlay render path
(dahlia-competitor-ad-adaptation-overlay-render Phase 5). The ad detail page
(`/api/ads/campaigns/[id]`) reads copy in this order:

1. **`readCopyVariants(campaignId)`** → `ad_creative_copy_variants` (temperature-banded pack, primary read source).
2. **`product_ad_angles.metadata.copy_pack`** — the 4×4 pack fallback when the campaign carries an `angle_id`.
3. **`ad_campaigns.metadata.copy_pack`** — the FALLBACK the `insertReadyCreative` broadcast writes onto the campaign row itself (the 102a218f held-draft fix).

Renders are re-signed from **`ad_videos.meta.storage_path`** for `format ∈ feed_4x5 | stories_9x16 | right_column_1x1`. Adapted output written only to `ad_campaigns` is **invisible** to the detail page — this module enforces the correct write-back targets so the overlay path can't ship a phantom-ready creative.

## Exports

- **`OVERLAY_LANDING_TARGETS`** — a stable constant enumerating the three write surfaces the detail page reads: `{ copyVariants: "ad_creative_copy_variants", angleCopyPack: "product_ad_angles.metadata.copy_pack", adVideos: "ad_videos" }`. Grep-token for the "copy lands in the angle copy_pack / copyVariants source" + "renders saved to ad_videos" verification.
- **`overlayFinalsStoragePath(workspaceId, videoId, ext) → string`** — the canonical `finals/{ws}/{videoId}.{ext}` storage path the ad detail page re-signs from. Grep-token: `finals/{ws}/{videoId}.{ext}`.
- **`buildAngleCopyPackUpdateBody(existingMetadata, copyPack) → { metadata }`** — pure. Preserves the angle's existing `metadata` JSONB (provenance / concept_tag / other keys) while writing `copy_pack`. Never clobbers an unrelated key.
- **`OverlayLandingStorage`** — storage seam: `{ uploadBuffer, signedUrl }`. Production callers omit the option (falls back to the real [[../ad-storage]] helpers); tests inject a fake so the write-target assertions run without a real bucket / network.
- **`landOverlayCreativePack(admin, opts) → { canonicalAdVideoId, siblingAdVideoIds[], angleCopyPackWritten, copyVariantsWritten }`** — the write orchestrator. Deterministic ordering:
  1. `product_ad_angles.metadata.copy_pack` (compare-and-set on `id + workspace_id`, splat-preserves prior metadata).
  2. `ad_videos` canonical insert → `uploadBuffer(finals/{ws}/{videoId}.jpg)` → `signedUrl` → flip row to `status='ready'` + `meta.storage_path=…` (compare-and-set on the update).
  3. `ad_videos` siblings — same as canonical but with `format_variant_of_id = canonicalId` (the same-psychology invariant expressible in the DB).
  4. `ad_creative_copy_variants` — the temperature-banded pack via [[ad-copy-variants]] `writeCopyVariants` (only when `opts.variants` is supplied).

## Compare-and-set guards (coaching #11-12)

Every mutation gates on the confirming predicate the read implied:

- `product_ad_angles.update({metadata})` is `.eq('id', angleId).eq('workspace_id', workspaceId).select('id')` — a cross-workspace angle-id collision or a concurrently-deleted angle produces `data.length === 0` and `angleCopyPackWritten` reports `false` rather than silently claiming the landing is complete.
- `ad_videos.update({status:'ready', meta:{storage_path}})` is `.eq('id', videoId).eq('workspace_id', workspaceId).select('id')` — a racing delete or cross-workspace bleed can't flip the wrong row to `ready`.
- `ad_creative_copy_variants` writes go through the existing [[ad-copy-variants]] `writeCopyVariants` chokepoint (upserts on the `(ad_campaign_id, audience_temperature)` unique key — idempotent).

## Callers

- [[creative-agent]] `stockProduct` on the overlay path (flag-gated via `DAHLIA_RENDER_MODE=overlay`) — composes the copy pack + the 3 rendered placements + the angle id and calls `landOverlayCreativePack` in place of (or alongside) `insertReadyCreative` so the copy + renders reach the detail page's read surfaces.
- Any Phase-5 backfill that needs to re-land an adapted creative pack to the correct targets can call the same function idempotently.

## Tests

`src/lib/ads/creative-overlay-landing.test.ts` — pins every write target + guard against a fake admin that records the chain calls + a fake storage seam:

- `OVERLAY_LANDING_TARGETS` is stable.
- `overlayFinalsStoragePath` produces the canonical `finals/{ws}/{videoId}.{ext}` pattern for both `.jpg` and `.png`.
- `buildAngleCopyPackUpdateBody` preserves prior `provenance` / `concept_tag` while writing `copy_pack`.
- `landOverlayCreativePack` reads the existing angle metadata with `.eq('id', ...).eq('workspace_id', ...)`, updates with the SAME compare-and-set + `.select('id')`, and preserves prior `provenance` on the update body.
- The canonical `ad_videos` insert body is `feed_4x5` / `static` / `pending` with `format_variant_of_id=null` and `meta.generated_by='ad-creative-overlay'` (distinguishes overlay-path landings from legacy ones in telemetry).
- Uploads land at `finals/{ws}/{videoId}.jpg` with `image/jpeg`; the update flips to `ready` + stamps `meta.storage_path`.
- Siblings' `format_variant_of_id` points at the canonical id.
- `writeCopyVariants` upserts on the `(ad_campaign_id, audience_temperature)` unique key.
- Null `angleId` skips the angle write and reports `angleCopyPackWritten=false`.
- PNG renders upload with `.png` + `image/png`.

## Related

- [[creative-pack]] `planCreativePackInserts` — the pure planner emitting the 3 ad_videos insert bodies + the `angleMetadataCopyPack` shape.
- [[ad-copy-variants]] `writeCopyVariants` — the SDK chokepoint for the temperature-banded pack.
- [[../ad-storage]] `uploadBuffer` / `signedUrl` — the default storage seam.
- [[../reference/competitor-ad-adaptation]] — the methodology this overlay-path lands.
- [[../lifecycles/ad-render]] — the whole overlay render pipeline this module is the last step of.
- [[../lifecycles/ad-publish]] — the downstream consumer that reads the landed rows.
