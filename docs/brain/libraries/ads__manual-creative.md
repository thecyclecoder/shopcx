# `src/lib/ads/manual-creative.ts` — Land a hand-produced creative into the ad library

The chokepoint for shelving a creative that was **not** produced by an autonomous lane, so Bianca's [[ads__ready-to-test|ready-to-test]] reader can pick it up and [[../lifecycles/ad-publish]] can ship it.

**Why it exists.** `insertReadyCreative` in [[ads__creative-agent|creative-agent]] is module-private and shaped for Dahlia's autonomous static lane — it expects a `product_ad_angles` row, the v3 attribution stamps (`creative_theme` / `angle_palette_id` / `headline_pattern_id` / `creative_combination_id`) and a Max copy-QC verdict. A creative produced outside that lane (a podcast-interview video ad, a founder-shot clip, a one-off Remotion render) has none of those. Before this SDK the only way to shelve one was a raw `.from("ad_campaigns").insert()` — exactly the hand-rolled write [[../../CLAUDE.md]] forbids ("Raw `.from(...)` with no SDK → STOP").

**North star.** The gate REFUSES rather than writing a degraded row. A creative that would publish as a `<4`-copy ad, breach a Meta cap, or carry a destination URL the attribution sensor can't resolve is a rail — and hitting a rail means stop, not execute ([[../operational-rules.md]] § North star). The SDK itself never escalates; it returns a typed refusal and the caller decides.

## Exports

| Export | Notes |
|---|---|
| `evaluateManualCreativeGate(args)` | **Pure**, no Supabase. First-match refusal in a deliberate order — pack completeness → Meta caps → destination URL → media → self-score — so a caller fixing refusals walks the same sequence every time. Returns `{ ok: true }` or `{ ok: false, reason, detail? }`. |
| `landManualCreative(admin, args)` | The writer. Runs the gate, then inserts `ad_campaigns` + `ad_videos`, uploads the bytes, and promotes both to `ready`. |
| `evaluateManualCopyRails(args)` | **Pure**, the copy-only half of the gate (pack completeness · Meta caps · self-score floor). Shared by the land gate and the copy updater so a REVISION clears the same bar as the insert. |
| `updateManualCreativeCopy(admin, opts)` | Revise copy on an already-landed creative in place. Writes `metadata.copy_pack` **and** the denormalised slot-0 `headline`/`primary_text`/`description` together — updating only the pack would leave the detail page showing stale copy while Meta served the new text. Media, landing URL, and publish state untouched. |
| `ManualCreativeRefusal` | Union of every deterministic refusal: `headlines_below_min` · `primary_texts_below_min` · `headline_over_cap` · `primary_text_over_cap` · `description_over_cap` · `missing_scent_match_params` · `empty_media` · `self_score_below_floor` · `missing_placement_coverage`. |
| `UpdateManualCreativeCopyResult` | `{ kind:'ok', adCampaignId, headlines, primaryTexts }` \| `{ kind:'refused', reason, detail? }` \| `{ kind:'failed', detail }`. |
| `LandManualCreativeResult` | `{ kind:'ok', campaignId, videoId, storagePath, finalUrl }` \| `{ kind:'refused', reason, detail? }` \| `{ kind:'failed', detail }`. |
| `LandManualCreativeArgs` / `ManualCreativeMedia` / `ManualCreativeGateResult` | Input + verdict shapes. |
| `evaluateManualStaticPackGate(args)` | **Pure**, the static-pack gate. Copy rails → destination URL → media → **placement coverage**. The coverage rail is the one the video gate has no equivalent for. |
| `landManualStaticPack(admin, args)` | The static writer. Lands ONE `ad_campaigns` row + THREE `media_kind='static'` `ad_videos` rows (canonical `feed_4x5` + a 9:16 sibling + a `right_column_1x1` sibling, siblings stamped with the canonical's `format_variant_of_id`). |
| `ManualStaticRender` / `LandManualStaticPackArgs` / `LandManualStaticPackResult` | Static-pack input + result shapes. |

## The rails, and what each one prevents

| Refusal | Downstream failure it prevents |
|---|---|
| `headlines_below_min` · `primary_texts_below_min` | Meta ships a single-copy ad with no text rotation — [[ads__creative-pack]] `CREATIVE_PACK_MIN` is 4 + 4 |
| `headline_over_cap` · `primary_text_over_cap` · `description_over_cap` | Graph rejects at creative-create. Caps are [[ad-tool-config]] `META_CAPS` = `{ headline: 40, primary_text: 1200, description: 90 }` |
| `missing_scent_match_params` | Without `?angle=&variant=` the attribution sensor buckets clicks to `(unresolved)` and per-creative ROAS goes dark — see [[../lifecycles/ad-publish]]. Checked with [[advertorial-pages]] `hasScentMatchParams` |
| `empty_media` | A `status='ready'` row pointing at media that was never stored |
| `self_score_below_floor` | Copy below the bar Dahlia's own author loop enforces — [[ads__creative-agent]] `AUTHOR_SELF_SCORE_FLOOR` (6). A **null** score skips the check, matching deterministic mode |

## What it writes

Mirrors the render path in [[../inngest/ad-tool]] (`render-formats`) so a manually-landed row is byte-comparable to a pipeline-rendered one:

| Table | Fields |
|---|---|
| [[../tables/ad_campaigns]] | `status='ready'` · `landing_url` · `audience_temperature` · `author_self_score` · `headline` / `primary_text` / `description` (slot 0 of the pack) · `metadata.copy_pack` (the full `MetaCopyPack`) |
| [[../tables/ad_videos]] | `status='ready'` · `media_kind='video'` · `format` · `final_mp4_url` (signed) · `meta.storage_path` = `finals/{workspace_id}/{ad_videos.id}.mp4` · `transcript_json.words` when supplied |

**`max_qc_eligible` is left NULL** — Max never ran on a hand-made creative. Bianca's `.not("max_qc_eligible","is",false)` filter treats NULL the same as TRUE, so the row is postable without pretending a QC pass happened ([[ads__ready-to-test]]).

**Write order is crash-safe.** The campaign lands `draft` and the video `rendering` FIRST, the bytes upload, and only then are both promoted to `ready`. A failure between those points leaves a visible draft with a stamped error rather than a `ready` row pointing at missing media.

## Formatting note — primary text is read on a phone

Meta truncates primary text behind a "… See more" tap. The first line has to stand alone and open a
loop, and the body needs blank-line paragraph breaks or it renders as a word wall. Neither is a rail
(newlines cost nothing against `META_CAPS.primary_text` = 1200), but both decide whether the body is
read at all. Founder feedback 2026-09-01 on the Creatine Prime+ podcast creative.

## Copy scoring is the caller's job

The gate enforces *structural* rails only. Conversion-psychology scoring stays upstream, exactly as it does for Dahlia — the author scores, the insert enforces structure. Callers should run [[ads__copy-rubric]] `scoreConversionPsychology` (the shared 0-10 LF8 · Schwartz · Cialdini · Hopkins · Sugarman rubric) and [[ads__copy-validator]] `validateGeneratedCopy` and pass the result as `selfScore`.

## Related

[[ads__creative-agent]] (the autonomous lane's private `insertReadyCreative`) · [[ads__ready-to-test]] (Bianca's reader) · [[ads__creative-pack]] (`MetaCopyPack`, `CREATIVE_PACK_MIN`) · [[ads__creative-pack-gate]] (the publish-boundary sibling rail) · [[ads__copy-rubric]] · [[ads__copy-validator]] · [[advertorial-pages]] · [[ad-storage]] · [[../lifecycles/ad-publish]] · [[../lifecycles/ad-render]] · [[../tables/ad_campaigns]] · [[../tables/ad_videos]]

## Statics are a different write from videos

`landManualCreative` is **video-shaped**: it hardcodes `media_kind:'video'`, writes the bytes to `finals/{ws}/{id}.mp4` under a `video/mp4` mime, and lands exactly ONE `ad_videos` row. That is wrong for a hand-produced static in three ways at once — wrong `media_kind`, wrong extension/mime, wrong row count.

[[ads__creative-pack|creative-pack]] `isCreativePackComplete` only treats a campaign as postable when it carries **three** `media_kind='static'` rows:

| Row | `format` | `format_variant_of_id` |
|---|---|---|
| canonical | `feed_4x5` | `NULL` |
| sibling | `stories_9x16` or `reels_9x16` | canonical's `id` |
| sibling | `right_column_1x1` | canonical's `id` |

…all `status='ready'` with `static_jpg_url` set, plus ≥4 headlines and ≥4 primary texts on the copy pack. Push JPEGs through the video path and you shelve a row Bianca's publish gate reads as a half-pack **forever** — there is no repair path, because the campaign already looks landed.

So `landManualStaticPack` exists alongside, and:

- reuses `evaluateManualCopyRails` — a hand-made static clears the identical copy bar as a hand-made video;
- reuses the autonomous lane's PURE `planCreativePackInserts` for the row bodies, so a hand-made pack and a Dahlia pack are byte-identical in shape;
- mirrors `insertOnePlacementRender` in [[ads__creative-agent|creative-agent]] for storage — same `finals/{ws}/{id}.{ext}` path, same `static_jpg_url` + `meta.storage_path` write;
- adds ONE rail the video gate has no analogue for: **placement coverage**, refused *before* the campaign row exists. A missing placement is caught while it is still free to fix, rather than becoming a permanent half-pack.

**Write order** matches the video path — campaign `draft` → every `ad_videos` row `pending` → bytes upload → each row flips `ready` as its own upload lands → campaign promoted **last**. A crash part-way leaves a visible draft whose incomplete pack `isCreativePackComplete` already refuses, which is the same verdict a genuinely half-rendered Dahlia pack gets.

```ts
const res = await landManualStaticPack(admin, {
  workspaceId, productId,
  name: "Amazing Coffee — how it works",
  landingUrl: "https://…/products/amazing-coffee-pods?angle=…&variant=…",
  audienceTemperature: "cold",
  copyPack,                                   // ≥4 headlines + ≥4 primary texts
  renders: [
    { format: "feed_4x5",         buffer: feed },
    { format: "stories_9x16",     buffer: stories },
    { format: "right_column_1x1", buffer: square },
  ],
});
```
