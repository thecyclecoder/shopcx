# `src/lib/ads/creative-learning.ts`

The **learning flywheel** behind Dahlia's ([[creative-agent]]) test selection (CEO 2026-07-10). Reads/writes [[../tables/creative_test_outcomes]] so each cycle makes better test ads than the last.

## The core principle: a combination fails, not a concept
A **combination** = the full ad config on top of a concept: **creative treatment × copy (headline/description/CTA) × destination URL**. The same concept (angle) tested with a different image/headline/CTA/destination is a **new** combination. So:
- A failed combination **never** retires the concept — an angle only becomes `retired` after **`MAX_FAILED_COMBOS_BEFORE_RETIRE` (3)** distinct combinations lose with none winning ("it would take multiple explores with different combinations before we say maybe this angle just isn't working" — CEO). This fixes the old bug where an angle was permanently excluded after one use.

## What it does
- **`loadCreativeLearning(admin, ws, product)`** → per-`angle_key` stats (tried / won / lost / pending / retired) + per-`treatment` win-rates + `bestTreatments` ranked by win-rate.
- **`nextTreatmentFor(angleKey, learning)`** → the next UNTRIED treatment for a concept, biased toward historically-winning treatments — so a re-explored angle gets a fresh combination and we lead with executions that tend to win.
- **`recordCombinationGenerated(...)`** — Dahlia writes a `pending` row per generated combination (concept + treatment + headline/description/CTA/destination + `combination_key`).
- **`stampCreativeOutcome(...)`** — the media buyer ([[media-buyer-agent]]) stamps `won` / `lost` / `reactivated` when it crowns / trims / reactivates the adset (resolves the row by `ad_campaign_id`, or `meta_adset_id` → [[../tables/ad_publish_jobs]]`.campaign_id`). No-op for non-system ads. **Column-name gotcha:** [[../tables/ad_publish_jobs]] exposes `campaign_id` (the `ad_campaigns` UUID FK) — NOT `ad_campaign_id`, which is a schema-drift name that never existed there. The `meta_campaign_id` column on `ad_publish_jobs` is the separate Meta campaign id (text), not a rename of `campaign_id`. Only [[../tables/creative_test_outcomes]] legitimately carries `ad_campaign_id` (its FK into `ad_campaigns`), so the insert/update sites at lines 126/168 keep that column verbatim — only the `ad_publish_jobs` lookup in `stampCreativeOutcome` was drift.

## The loop
Dahlia generates a combination (`pending`) → the media buyer tests it → stamps the outcome → Dahlia's next `loadCreativeLearning` biases selection: **retire** exhausted concepts, **re-explore** promising ones in fresh combinations, **double down** (win → prefer that concept), **lead with winning treatments**. This is the explore→exploit graduation engine's memory. [[creative-agent]] · [[media-buyer-agent]] · [[../functions/growth]].
