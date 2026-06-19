# `src/lib/adlibrary.ts` — AdLibrary.com discovery client

Discovery half of the winning-static-creative finder (Phase 2). Searches [[../integrations/adlibrary]] for long-running competitor + category ads, classifies static vs video at pull time, and fetches creative bytes (Bearer key) for vision. See [[../specs/winning-static-creative-finder]].

## Exports

| Export | Notes |
|---|---|
| `hasAdLibraryKey()` | `ADLIBRARY_API_KEY` present? (cron/route gate) |
| `searchAds({ keyword, appType?, geo?, daysBack?, pageSize? })` | → `NormalizedAd[]`. POST /api/search; throws `adlibrary_search_${status}` on non-2xx |
| `fetchCreative(url)` | → `{ buffer, contentType }`. Sends the Bearer key (urls 403 without it) |
| `classifyMedia(ad)` | `'static' \| 'video'` from `video_duration` → `ads_type` → `resource_urls[].type` |
| `isLongRunner(ad, minDays=14)` | winner heuristic: `days_count ≥ minDays` AND `resume_advertising_flag !== false` |
| `NormalizedAd` / `AdLibraryAd` / `MediaType` | types; `NormalizedAd` adds `media_type` + best `creative_url` |
| `CATEGORY_SEEDS` / `COMPETITOR_SEEDS` / `ALL_SEEDS` | curated discovery seeds; `Seed = { keyword, kind, note? }` |

## Seed list (curated + data-surfaced)

- **Competitors** (brand name = keyword): `everydaydose`, `ryze`, `lifeboost`, `urthlabs`/`erthlabs`, `leanjoebean`, `atlascoffeeclub`, `piquelife`, `mudwtr` (Amazing Coffee); `onnit` (Ashwavana); `bloomnu` (greens cross).
- **Categories:** superfood/mushroom/adaptogen coffee, energy-without-jitters, anti-inflammatory, longevity, anti-aging, weight-loss coffee, ashwagandha, greens.

## Gotchas

- **`body` copy is thin → vision is mandatory** (Phase 3); this file only surfaces the creative urls.
- **Bearer key required on creative fetch** — never raw-fetch a preview/resource url.
- **`keyword` is the only filter** the API honors (no brand/niche params).
- Respects credits: callers dedup by `ad_key` and throttle searches (10/min cap).

## Callers
- [[creative-skeleton]] (`sweepSeed` → `searchAds`/`fetchCreative`/`isLongRunner`).
- [[../inngest/creative-finder]] (`hasAdLibraryKey`, `ALL_SEEDS`).
- `src/app/api/ads/creative-finder/media` (`fetchCreative` proxy).

## Related
[[../integrations/adlibrary]] · [[creative-skeleton]] · [[../tables/creative_skeletons]] · [[../inngest/creative-finder]] · [[../specs/winning-static-creative-finder]]
