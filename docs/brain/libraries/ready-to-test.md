# ready-to-test

Queries the **ready-to-test queue** — creatives produced by [[ad-static]], [[ad-render]], or [[../lifecycles/creative-finder]] that are finished but not yet launched into an active ad set. Used by the Growth director to supervise + approve creative promotions before they spend.

**Code:** `src/lib/ads/ready-to-test.ts` · **Function:** `listReadyToTest(admin, {workspaceId, productId?, temperature?})` → `{ readyToTest[]: { ad_campaign_id, archetype, lander_url, status:'ready_no_active_ad', formats:string[], created_at, concept_tag, audience_temperature } }`

## Behavior

Returns every `ad_campaigns` row that has:
- `status ≠ 'archived'` (excludes retired campaigns whose landing URL was removed), AND
- ≥1 `ad_videos` with `status='ready'` (or `media_kind='static'` final JPG), AND
- `landing_url` set, AND
- NO active `ad_publish_jobs` row in `status in ('queued','uploading','creating','published')`, AND
- **([[../specs/max-qc-always-bins-ad-7of10-gates-only-bianca-postability]] Phase 2)** `max_qc_eligible ≠ false` — creatives where Max's copy-QC hard gates failed or his persuasion score was sub-7/10 are binned-but-ineligible (archived from Bianca's postable list) by both a DB-level filter `.not("max_qc_eligible","is",false)` and a JS-side guard, so they don't leak into the media buyer's replenish deficit fill. NULL and TRUE both surface (NULL = Max never ran / deterministic mode / legacy pre-Phase-2 rows preserve today's byte-for-byte behavior). The ineligible row still exists on the ad detail page with Max's critiques visible for founder inspection.
- **([[../specs/media-buyer-product-scoped-test-rail]] Phase 2)** when `productId` is passed, `ad_campaigns.product_id` matches it so the media-buyer's replenish never feeds one product's creatives into another's cohort adset. Omitting `productId` (or passing `null`) preserves the workspace-wide read used by the null-product default cohort.
- **([[../specs/bianca-route-ready-creatives-by-dahlia-temperature-tag]] Phase 1)** when `temperature` is passed (`'cold'` | `'warm'` | `'hot'`), `ad_campaigns.audience_temperature` matches it — the Bianca replenish path always passes `'cold'` so a Warm/Hot creative Dahlia tagged cannot leak into the cold rail's deficit fill (the M4 crown signal is only meaningful when the tested set is temperature-uniform). Omitting `temperature` (or passing `null`) preserves the pre-Phase-1 read verbatim — nothing regresses when the column is untagged or the caller does not care about the band.

Every row also carries `audience_temperature` (Dahlia's tag; nullable — untagged / deterministic-mode creatives are `null`) so a downstream audit can cite the routed band without re-reading `ad_campaigns`.

The reader is **pure read** — no schema changes, no writes. It surfaces candidates for the Director-approval flow ([[../lifecycles/ad-publish]] "promote ready to test").

## Cross-links

[[ad-static]] · [[ad-render]] · [[../lifecycles/creative-finder]] · [[../lifecycles/ad-publish]] · [[../functions/growth]] · [[../tables/ad_campaigns]] · [[../tables/ad_videos]] · [[../tables/ad_publish_jobs]] · [[../specs/media-buyer-product-scoped-test-rail]]
