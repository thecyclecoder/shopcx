# meta-ad-library

**Meta Ad Library** (`GET /{version}/ads_archive`) — the source of record for competitor ads. Replaced [[adlibrary]] on 2026-08-24 when the founder's Meta identity confirmation landed. Free, official, and carries data the vendor never had: real per-ad delivery dates, targeting, placements, and Meta's own media-type classification.

Client: [[../libraries/meta-ad-library.md]] · resolution: [[../libraries/meta-ad-library-resolve.md]] · render: [[../libraries/meta-ad-library-render.md]] · lands in [[../tables/creative_skeletons.md]] · driven by [[../inngest/creative-scout.md]].

## Auth — per-workspace, and ONLY a user token

This is the sharpest break from AdLibrary, whose `ADLIBRARY_API_KEY` was a process-wide env var.

| Token | Result |
|---|---|
| App token (`META_APP_ID\|META_APP_SECRET`) | ✗ `code=10/2332004` — "Application does not have permission for this action" |
| Page access token | ✗ same error |
| **User access token** (ID-confirmed person) | **✓ 200** |

The archive answers only to a token belonging to a person who has completed Meta identity confirmation. The credential is therefore `workspaces.meta_user_access_token_encrypted` (AES-256-GCM, [[../libraries/crypto.md]]), **not** an env var — so every entry point takes a `workspaceId` and is async. `hasAdLibraryAccess(workspaceId)` replaced the old synchronous `hasAdLibraryKey()`.

A workspace that hasn't connected Meta is skipped individually; the cron no longer short-circuits globally on one missing env var.

> ⚠️ If that token is revoked or re-issued via OAuth, the whole lane goes dark. Error `190/460` = expired ⇒ re-auth needed.

## Key calls

| Call | Purpose |
|---|---|
| `GET /ads_archive?search_page_ids=["{pageId}"]` | **The collection call.** An advertiser's FULL library with real dates. One call — no paid "winners" endpoint, because longevity is computed, not bought. |
| `GET /ads_archive?search_terms={term}` | Discovery only. ⚠️ Matches ad **COPY**, not advertiser name. |
| `GET /debug_token` | Token type / scopes / expiry sanity. |

Required on every call: `ad_reached_countries` (the archive is per-country by law) and `ad_type=ALL`. Paging via `paging.next`, 100/page, capped at 20 pages.

## Fields we get — and the ones we deliberately don't

Meta's `ArchivedAd` node has 28 fields. Present and used: `id`, `page_id`, `page_name`, `ad_creative_bodies`, `ad_creative_link_titles/captions/descriptions`, `ad_delivery_start_time`, `ad_delivery_stop_time`, `ad_snapshot_url`, `publisher_platforms`, `languages`, `target_ages`, `target_gender`, `target_locations`, `eu_total_reach`.

**Absent for US commercial ads** (political/issue + EU only): `impressions`, `spend`, `demographic_distribution`, `estimated_audience_size`, `delivery_by_region`. There is no engagement data at all — no likes/comments/shares/views.

So `heat`, `impression`, `estimated_spend`, `all_exposure_value`, and the four engagement counts on [[../tables/creative_skeletons.md]] are **NULL on every new row**. Founder 2026-08-24: *"we don't care about the engagement etc."* Longevity replaces them — and it's a better signal, because Meta's dates are measured where AdLibrary's `heat` was a vendor estimate.

> **Gotcha — the API silently ignores unknown fields.** Requesting a bogus field returns **no error**; it's accepted and dropped. So you cannot enumerate the field set by probing, and a typo'd field name fails silently as an absent value. Trust the [ArchivedAd reference](https://developers.facebook.com/docs/marketing-api/reference/archived-ad/), not experiment.

## ⚠️ There is NO media url — the creative needs a browser

The single field carrying the creative is `ad_snapshot_url`, documented as *"displays uncompressed images and videos"* — a **JS-rendered page**. Everything cheaper was tried (2026-08-24, live) and fails:

| Route | Result |
|---|---|
| Bare fetch of the snapshot url | HTTP 200, 174KB shell, **0 creative urls** (289 fbcdn refs, all static chrome) |
| Same + browser User-Agent | **HTTP 400** |
| `facebook.com/ads/library/?id=` permalink | **HTTP 403** |
| GraphQL `doc_id` route | Needs an `lsd` token off the permalink → 403 |

Rendering the snapshot in a real browser yields exactly one creative image per ad — verified: `image/jpeg`, 43,847 bytes, magic `ff d8 ff e0`, 483×600.

This is **not** fragile UI scraping. The url comes from the API, its documented purpose is displaying the creative, it renders one ad (no pagination, no search UI), and it triggered no bot detection where the library UI 403'd. The extraction selector is "the largest `<img>` on the page."

The signed `scontent.*.fbcdn.net` url carries `oh=`/`oe=` expiry params and 403s outside the page context — so bytes are fetched **inside** the page and stored immediately. Never persist that url; `creative_skeletons.thumb_path` already stores our own copy.

### Where it runs

Playwright is on the **box**, not Vercel. Split (founder 2026-08-24): **Vercel discovers, the box renders.** [[../inngest/creative-scout.md]] keeps the weekly cron and decides *what* to scout, then enqueues a `creative-scout` [[../tables/agent_jobs.md]] row per product; `scripts/builder-worker.ts` → `runCreativeScoutJob` does collect → render → vision → persist as ONE unit.

The unit is the whole per-product sweep, not just the render — splitting discovery from rendering would write skeleton rows with no creative and no vision, a partial-row state every downstream reader would have to learn to skip.

## ⚠️ Ads Meta took down have NO creative

When Meta removes an ad for Advertising Standards it **strips the creative from the archive**. The snapshot renders copy plus a 60px avatar, forever. Detected at ingestion via the link caption (`isCreativeRemoved`) — two wordings:

- *"This ad was run by an account or Page we later disabled for not following our Advertising Standards."*
- *"This content was removed because it didn't follow our Advertising Standards."*

Filtering them took a live Erth render pass from **14/26 to 22/22**. Of Erth's 44 network statics, **22 are removed and permanently unrecoverable**. A permanent render failure is recorded as `status='failed'`; a transient one is rethrown so the ad stays eligible next sweep.

## media_type — MEME is our "static"

`media_type` is a **search filter**, not a returned field. Vocabulary: `IMAGE` · `MEME` · `VIDEO` · `NONE`.

Founder 2026-08-24: *"what we consider as a static ad is probably what meta calls Meme and that's ok."* So the static pool is **IMAGE + MEME**.

This is load-bearing. Erth Labs' 79 US ads: **0 IMAGE, 26 MEME, 53 VIDEO.** Filtering on `IMAGE` alone would report a prolific advertiser as having *no statics at all*.

## ⚠️ `search_terms` matches ad COPY, not advertiser name

There is **no advertiser-name search**. All documented routes are closed: `/pages/search` → code 10 (needs Page Public Content Access); `GET /{vanity-handle}` → code 100; `/search?type=page` → empty.

Searching `"everydaydose"` returned 9 ads from UGC affiliates who merely *mention* the brand — the top result by ad count was an unrelated travel influencer.

Resolution therefore works off a property of the archive itself: every row carries `page_id` + `page_name`, so we cast a wide keyword net and pick the advertiser whose name **strictly** matches (`nameMatches`). "Most ads" is only a tiebreak *among* name-matched candidates, never a selector. Proven: "mud wtr" → `MUD\WTR`/172538983355501, "Erth Labs" → 656545627533387.

`competitors.meta_page_id` is already populated for most rows and short-circuits resolution entirely.

## Affiliate networks are visible — and worth pulling

A brand's own page is not its whole footprint. Erth runs **110 ads across 7 pages**; only 79 are on the brand page. The rest are persona/advertorial pages whose creative uses a *visibly different angle* — the brand page runs pure offer ("40% OFF + FREE Gifts"), the personas run problem-first hooks ("The Coffee Swap Your Gut Needs ☕", 94d, still running).

`discoverAffiliatePages` surfaces them. Requires ≥3 brand-pointing ads AND ≥80% of the page's ads pointing at the brand domain, so an affiliate that ran two of the brand's links isn't promoted to "the brand."

> Note `Holistic Health Finds` was in `competitors` as a standalone competitor — it's actually an Erth affiliate (30 erth-pointing ads).

## Rate limits

Standard Graph budgets via `X-App-Usage` / `X-Page-Usage`. Retryable: HTTP 429/5xx and codes 1, 2, 4, 17, 341, 613. **Terminal** (never retry): 190 (bad token), 10 (permission). No per-search credit — the 7s inter-search throttle that existed to protect AdLibrary's paid quota was removed; it protected nothing here.

## Known gap — API vs UI count

The Ad Library **UI** showed **~180 results** for Erth Labs where the API returned **79** for the same page and country. Unresolved: the UI may count creative variants differently, or the API may filter something. **Do not treat an API count as a complete census** until this is pinned down.

## What the migration dropped

- **Engagement/scale columns** — null on all new rows (accepted; see above).
- **`call_to_action`** — Meta doesn't expose the CTA button label anywhere.
- **The video lane** — the scout is statics-only, so no new video rows arrive. The 64 legacy `video_pending` rows drain through a self-contained legacy fetch in [[../libraries/video-skeleton.md]] that needs `ADLIBRARY_API_KEY`; when that key goes, they become undrainable. Expected and accepted.
- **The live-proxy route** (`/api/ads/creative-finder/media`) — deleted. It existed to live-fetch AdLibrary creatives for rows with no local copy; the ship-time backfill gave all 1,330 rows a `thumb_path`, and Meta rows can never have a fetchable `image_url`.

## Related
[[adlibrary]] (retired) · [[meta-graph]] · [[meta-marketing]] · [[../libraries/creative-skeleton.md]] · [[../tables/competitors.md]] · [[../lifecycles/creative-finder.md]]
