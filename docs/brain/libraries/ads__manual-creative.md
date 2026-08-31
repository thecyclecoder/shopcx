# `src/lib/ads/manual-creative.ts` — Land a hand-produced creative into the ad library

The chokepoint for shelving a creative that was **not** produced by an autonomous lane, so Bianca's [[ads__ready-to-test|ready-to-test]] reader can pick it up and [[../lifecycles/ad-publish]] can ship it.

**Why it exists.** `insertReadyCreative` in [[ads__creative-agent|creative-agent]] is module-private and shaped for Dahlia's autonomous static lane — it expects a `product_ad_angles` row, the v3 attribution stamps (`creative_theme` / `angle_palette_id` / `headline_pattern_id` / `creative_combination_id`) and a Max copy-QC verdict. A creative produced outside that lane (a podcast-interview video ad, a founder-shot clip, a one-off Remotion render) has none of those. Before this SDK the only way to shelve one was a raw `.from("ad_campaigns").insert()` — exactly the hand-rolled write [[../../CLAUDE.md]] forbids ("Raw `.from(...)` with no SDK → STOP").

**North star.** The gate REFUSES rather than writing a degraded row. A creative that would publish as a `<4`-copy ad, breach a Meta cap, or carry a destination URL the attribution sensor can't resolve is a rail — and hitting a rail means stop, not execute ([[../operational-rules.md]] § North star). The SDK itself never escalates; it returns a typed refusal and the caller decides.

## Exports

| Export | Notes |
|---|---|
| `evaluateManualCreativeGate(args)` | **Pure**, no Supabase. First-match refusal in a deliberate order — pack completeness → Meta caps → destination URL → media → self-score — so a caller fixing refusals walks the same sequence every time. Returns `{ ok: true }` or `{ ok: false, reason, detail? }`. |
| `landManualCreative(admin, args)` | The writer. Runs the gate, then inserts `ad_campaigns` + `ad_videos`, uploads the bytes, and promotes both to `ready`. |
| `ManualCreativeRefusal` | Union of every deterministic refusal: `headlines_below_min` · `primary_texts_below_min` · `headline_over_cap` · `primary_text_over_cap` · `description_over_cap` · `missing_scent_match_params` · `empty_media` · `self_score_below_floor`. |
| `LandManualCreativeResult` | `{ kind:'ok', campaignId, videoId, storagePath, finalUrl }` \| `{ kind:'refused', reason, detail? }` \| `{ kind:'failed', detail }`. |
| `LandManualCreativeArgs` / `ManualCreativeMedia` / `ManualCreativeGateResult` | Input + verdict shapes. |

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

## Copy scoring is the caller's job

The gate enforces *structural* rails only. Conversion-psychology scoring stays upstream, exactly as it does for Dahlia — the author scores, the insert enforces structure. Callers should run [[ads__copy-rubric]] `scoreConversionPsychology` (the shared 0-10 LF8 · Schwartz · Cialdini · Hopkins · Sugarman rubric) and [[ads__copy-validator]] `validateGeneratedCopy` and pass the result as `selfScore`.

## Related

[[ads__creative-agent]] (the autonomous lane's private `insertReadyCreative`) · [[ads__ready-to-test]] (Bianca's reader) · [[ads__creative-pack]] (`MetaCopyPack`, `CREATIVE_PACK_MIN`) · [[ads__creative-pack-gate]] (the publish-boundary sibling rail) · [[ads__copy-rubric]] · [[ads__copy-validator]] · [[advertorial-pages]] · [[ad-storage]] · [[../lifecycles/ad-publish]] · [[../lifecycles/ad-render]] · [[../tables/ad_campaigns]] · [[../tables/ad_videos]]
