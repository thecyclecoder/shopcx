# inngest/creative-scout

The **deliberate per-product Creative Scout** — the imitate feed for the imitate→innovate loop (CEO 2026-07-12). Replaces the retired workspace-wide `creative-finder` sweep. For each of our products that has ≥1 APPROVED competitor (`competitors.product_id`), it pulls that product's competitors' long-running ads from AdLibrary, vision-deconstructs the statics into [[../tables/creative_skeletons]] **tagged with `competitor_id` + `product_id`**, and parks videos for the [[creative-finder]] video pipeline. Dahlia's `getProvenCompetitorAngles(productId)` ([[../libraries/creative-sourcing]]) then reads exactly that product's shelf — **a product imitates only the competitors WE chose for it**, not a workspace-wide soup.

**File:** `src/lib/inngest/creative-scout.ts`

## Why per-product (the base-layer fix)

Before this, [[../libraries/creative-agent]] `stockProduct` sourced competitor angles by a `coffee/weight` niche SUBSTRING match on advertiser/hook — deliberate per-product competitors never drove imitate at all. And the old sweep pulled ALL competitors + `CATEGORY_SEEDS` at once, risking AdLibrary's 10-searches/min cap. The scout fixes both:

- **Per-PRODUCT cadence.** It iterates product-by-product; each product's ~5 competitors is one small batch, 7s throttle between searches → every run stays far under the rate cap. The manual event takes an optional `productId` so ONE product can be scouted on demand (Dylan's requirement — "the scout should be able to be ran on a per product basis").
- **Deliberate tagging.** Every ingested skeleton carries `competitor_id` (the approved `competitors.id`) + `product_id` (the product that competitor was chosen for), threaded from the seed through [[../libraries/creative-skeleton]] `ingestAd`.

## Fully deliberate — what was DROPPED

Category auto-discovery is gone. No `CATEGORY_SEEDS`, no `promoteFromCategorySweep` (heavy advertisers recurring in category sweeps → 'proposed' competitors). Competitors are chosen by hand (`discoverCompetitors` proposals + manual approval). See [[../operational-rules]] § North star — a deliberate, supervisable set beats a proxy-optimized auto-discovery.

## What was PRESERVED

The two adjacent per-workspace side-effects the old sweep fed, both keyed off APPROVED competitors (so they survive the deliberate cut), run once per workspace after its products are swept:
- `promoteWhitelistedPages` — affiliate/advertorial pages fronting a KNOWN competitor (domain join) → 'proposed' whitelisted rows.
- `syncResearchUrlsFromCreatives` — Rhea's URL sensor upserts one `research_urls` row per distinct destination.

The heavier **video drain** stays in [[creative-finder]] (`creativeFinderVideoProcess`, cron `30 9 * * *`) — the scout parks videos as `video_pending` (product-tagged); that function downloads → ffmpeg keyframes + Whisper → the four-slot skeleton, tags preserved.

## Functions

### `creativeScoutWeeklyCron`
- **id** `creative-scout-weekly-cron` · **cron** `0 9 * * 1` (Mon 9am) · retries 1.
- For every ad-tool workspace (has `ad_campaigns` rows), sweep every product with approved competitors, then the per-workspace side-effects. Emits a Control Tower heartbeat (`creative-scout-weekly-cron`).

### `creativeScoutManualSweep`
- **id** `creative-scout-manual-sweep` · **event** `ads/creative-scout.sweep` · retries 1.
- Data `{ workspaceId?, productId?, force? }`. `workspaceId` scopes to one tenant; `productId` scopes to ONE product (the per-product on-demand path); `force=true` bypasses the freshness gate (explicit spend). Fired by `POST /api/ads/creative-finder` (the dashboard "Run sweep now" button, now scout-backed).

## The sweep, per product

1. `loadApprovedCompetitorsForProduct(workspaceId, productId)` ([[../libraries/competitors]]) → Seeds carrying `competitorId` + `productId`. `search_keyword` (exact page/brand name the API matches literally) wins over `brand`.
2. Freshness gate (unless `force`): `filterSeedsByFreshness` drops brands searched inside `adlibraryFreshnessDays()` (default 7). A fresh/never-searched brand always passes → a newly-approved competitor runs on the very next scout.
3. Per kept seed: `sweepSeed` → `searchAds` → `isWinner` filter (reach/spend OR longevity) → dedup by `ad_key` → rank by `winnerScore` → cap statics (vision cost) + videos → `ingestAd` (statics vision-deconstructed + `status='analyzed'`; videos `status='video_pending'`). 7s `step.sleep` between searches.

## Gotchas

- **A product with zero approved competitors is silently skipped** — the scout does zero pulls for it (no hardcoded fallback). Approve a competitor row (with `product_id` set) to feed it.
- **Whitelisted rows need `product_id` to be scouted per-product.** `loadApprovedCompetitorsForProduct` filters on `product_id`; an approved `source='whitelisted'` row without one won't be swept. (Latent gap — the old workspace-wide read had no product filter. Set `product_id` on approval to include it.)
- **Video cover-frame ≠ static.** AdLibrary tags `media_type`; videos park as `video_pending`, never ingested as `analyzed` statics. When shortlisting a scouted skeleton for imitation, trust `media_type` — a video's cover frame is NOT a static ad.
- **Heartbeat id is stable.** `creative-finder-video-process` kept its id through the retire so Control Tower tracking is uninterrupted; the scout adds its own `creative-scout-weekly-cron` beat.

## Related

[[creative-finder]] · [[competitor-scout]] · [[acquisition-research-cadence]] · [[../tables/creative_skeletons]] · [[../tables/competitors]] · [[../libraries/competitors]] · [[../libraries/creative-skeleton]] · [[../libraries/creative-sourcing]] · [[../libraries/creative-agent]] · [[../lifecycles/ad-render]] · [[../operational-rules]]
