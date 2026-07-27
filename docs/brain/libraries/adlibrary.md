# `src/lib/adlibrary.ts` — AdLibrary.com discovery client

Discovery half of the winning-static-creative finder (Phase 2). Searches [[../integrations/adlibrary]] for long-running competitor + category ads, classifies static vs video at pull time, and fetches creative bytes (Bearer key) for vision. See [[../lifecycles/creative-finder]] · [[../specs/winning-static-creative-finder]].

## Exports

| Export | Notes |
|---|---|
| `hasAdLibraryKey()` | `ADLIBRARY_API_KEY` present? (cron/route gate) |
| `searchAds({ keyword?, domain?, adsType?, platform?, appType?, geo?, daysBack?, pageSize? })` | → `NormalizedAd[]`. POST /api/search; throws `adlibrary_search_${status}` on non-2xx. Called by the [[creative-skeleton]] winners-empty fallback (2026-07-19) with `{ keyword \| domain, adsType:['1'], platform:['facebook','instagram'], geo:['USA'] }` when `scanWinners` returns 0 for a resolved competitor — so a brand with 0 winners but dozens of live statics (NativePath, Vital Proteins) still populates the skeleton library. |
| `fetchCreative(url, opts?)` | → `{ buffer, contentType }`. Sends the Bearer key (urls 403 without it); **retries transient upstream statuses** (408/429/500/502/503/504) on a bounded backoff (`maxAttempts=3`, `baseDelayMs=200`) before surfacing the terminal `adlibrary_creative_${status}` error. Non-transient statuses (401/403/404/…) fail-fast. Protects creative ingestion from brief AdLibrary CDN blips so one vendor 503 doesn't permanently poison a dedup-keyed ad row. See [[../specs/adlibrary-creative-fetch-transient-retry]]. |
| `TRANSIENT_ADLIBRARY_CREATIVE_STATUSES` | readonly set: `[408, 429, 500, 502, 503, 504]`. Statuses that mean "vendor CDN blip, not our fault" — bounded retry can recover. |
| `isTransientAdlibraryCreativeStatus(status)` | classifier for the transient set. |
| `RETRYABLE_CREATIVE_FETCH_STATUSES` | readonly set: `[408, 425, 429, 500, 502, 503, 504]`. Statuses (thrown by `fetchCreative` as `adlibrary_creative_${status}`) that mean "external service blip, not our fault" — a transient fetch failure, distinguishable from terminal errors (401/403/404) that should permanently fail an ad row. Used by [[creative-skeleton]] `ingestAd` to skip DB persistence on retryable errors. |
| `isRetryableCreativeFetchError(err)` | → boolean. Classifier for retryable creative-fetch failures — either a transient HTTP status thrown by `fetchCreative` (`adlibrary_creative_<status>` matching `RETRYABLE_CREATIVE_FETCH_STATUSES`) or a Node `fetch` network error (`TypeError('fetch failed')` / `AbortError` for connect-timeout / socket-reset). Called by [[creative-skeleton]] `ingestAd` + `collectAndTrack` to branch: skip DB write + log bounded warning instead of error so a single AdLibrary 503 doesn't permanently poison a competitor ad's dedup key. The same `ad_key` stays eligible for retry on the next sweep. |
| `FetchCreativeOpts` | type; optional retry config: `{ maxAttempts?, baseDelayMs?, fetchImpl?, sleepImpl? }` (testing injection). |
| `classifyMedia(ad)` | `'static' \| 'video'` from `video_duration` → `ads_type` → `resource_urls[].type` |
| `isWinner(ad, {minDays=7, minImpressions=50_000, minSpend=500})` | **the winner heuristic** `sweepSeed` uses: worth analyzing if `days_count ≥ minDays` **OR** `impression ≥ minImpressions` **OR** `estimated_spend ≥ minSpend` — reach/spend, not longevity alone. |
| `winnerScore(ad)` | rank for a capped sweep — `impression + spend·50 + days·500` (impressions first, Meta's own signal). |
| `isLongRunner(ad, minDays=14)` | the ORIGINAL longevity-only gate (`days ≥ minDays` AND `resume_advertising_flag !== false`). Superseded by `isWinner`; kept for reference. **Why it was replaced:** it dropped 72% of a fast-iterating brand's live ads, and its `resume_advertising_flag` cut silently discarded recently-paused HIGH-impression winners (Erth's 576K/549K/420K-impression statics). |
| `NormalizedAd` / `AdLibraryAd` / `MediaType` / `Seed` | types; `NormalizedAd` adds `media_type` + best `creative_url`; `Seed = { keyword, kind, note? }` |
| ~~`CATEGORY_SEEDS`~~ | RETIRED 2026-07-12 — category keywords fed category auto-discovery; the [[../inngest/creative-scout]] pulls only deliberate per-product competitor brands |

## Full-payload capture (ad-creative-scout)

`normalize()` keeps the **COMPLETE** AdLibrary row, not just the creative ([[../specs/ad-creative-scout]]): `destination_domain` (`ecom_advertiser_id` → bare host), **`landing_page_url`** (the FULL destination WITH path — the real advertorial, e.g. `https://learn.erthlabs.co/women50`; present on ~half the ads, `has_source_url`), **`ad_snapshot_url`** (`facebook.com/ads/archive/render_ad/?id=<archive_id>&access_token=…` — renders the actual Meta ad), **`page_id`** (the Meta page id), `has_store_url`, `call_to_action`, full copy (`body`/`message`), spend (`estimated_spend`/`all_exposure_value`/`impression`), engagement (`like`/`comment`/`share`/`view` → `*_count`), `platform`/`fb_merge_channel`/`ads_type`. All persisted onto [[../tables/creative_skeletons]] by [[creative-skeleton]] `ingestAd`. Field reads are defensive (multiple key aliases) since AdLibrary's row shape drifts; unknown fields still pass through `raw`. **The real lander bridge is `landing_page_url`, NOT `destination_domain`** — the bare-domain root frequently 404s because advertorials live at a slug ([[landing-page-scout]] `adDestinationsForBrand` prefers it).

## Seed list

- **Categories** (still hardcoded here): superfood/mushroom/adaptogen coffee, energy-without-jitters, anti-inflammatory, longevity, anti-aging, weight-loss coffee, ashwagandha, greens.
- **Competitors are DB-driven + per-product** — they live in the [[../tables/competitors]] table (`product_id`), not here. `COMPETITOR_SEEDS`/`ALL_SEEDS`/`CATEGORY_SEEDS` are gone; the [[../inngest/creative-scout]] loads a product's approved competitors via [[competitors]]`.loadApprovedCompetitorsForProduct()`. See [[../specs/competitor-scout]].

## Retry on transient creative downloads

`fetchCreative` bounces 408/429/500–504 upstream (brief CDN blips) on a **bounded backoff**: initial attempt + up to 2 retries on transient statuses, sleeping `baseDelayMs × attempt_number`. Non-transient statuses (401/403/404/…) fail immediately so we surface real errors (bad credentials, dead URLs) rather than mask them. The error shape `adlibrary_creative_${status}` is preserved after retries exhaust — callers still see a deterministic, retryable error, not a generic timeout. Built-in defaults: 3 attempts, 200ms base delay; both injectable for tests. [[../specs/adlibrary-creative-fetch-transient-retry]] Phase 1 — protects `creativeSkeletonFromSeed` so one vendor outage doesn't permanently poison a dedup-keyed competitor ad row.

## Gotchas

- **`body` copy is thin → vision is mandatory** (Phase 3); this file only surfaces the creative urls.
- **Bearer key required on creative fetch** — never raw-fetch a preview/resource url.
- **`keyword` is the only filter** the API honors (no brand/niche params).
- Respects credits: callers dedup by `ad_key` and throttle searches (10/min cap).

## Callers
- [[creative-skeleton]] (`sweepSeed` → `searchAds`/`fetchCreative`/`isLongRunner`).
- [[../inngest/creative-scout]] + [[../inngest/creative-finder]] (`hasAdLibraryKey`, `Seed`).
- [[competitors]] (`Seed` type — now carries `competitorId`/`productId` — for `loadApprovedCompetitorsForProduct`).
- `src/app/api/ads/creative-finder/media` (`fetchCreative` proxy).

## Related
[[../integrations/adlibrary]] · [[creative-skeleton]] · [[competitors]] · [[../tables/competitors]] · [[../tables/creative_skeletons]] · [[../inngest/creative-finder]] · [[../specs/winning-static-creative-finder]] · [[../specs/competitor-scout]]
