# adlibrary

**AdLibrary.com** — ad-intelligence index used to discover long-running competitor + category ads (the winners we reverse-engineer). Chosen because it works with **no KYC**, unlike Meta's Ad Library API which is gated behind facebook.com identity confirmation. See [[../lifecycles/creative-finder]] · [[../specs/winning-static-creative-finder]] · client: [[../libraries/adlibrary]].

## Auth

- **Env only:** `ADLIBRARY_API_KEY` (Business tier). In `.env.local` + Vercel; never committed.
- Sent as `Authorization: Bearer ${ADLIBRARY_API_KEY}` on **both** the search call **and every creative fetch** (preview/resource urls 403 without it).

## Key calls

| Call | Purpose |
|---|---|
| `POST https://adlibrary.com/api/search` | Body `{ keyword, appType:"3", geo:["USA"], daysBack, pageSize }` → ad rows (advertiser, title, scale, longevity, creative urls). 1 credit/search. |
| `GET <preview_img_url / resource_urls[].u>` (Bearer) | Fetch the creative bytes for vision (statics) or download (video). |

## Response shape (fields we read)

- **Identity/scale:** `ad_key` (dedup key), `advertiser`, `title`, `body` (⚠️ thin/empty), `all_exposure_value`, `impression`, `heat`.
- **Longevity (winner proxy):** `first_seen`, `last_seen`, `days_count`, `resume_advertising_flag`.
- **Creative + routing:** `preview_img_url`, `resource_urls[]` (`{type,u}`), `video_duration` (0=static), `ads_type` (1=image, 2=video).

## Gotchas

- **`body` copy is thin/empty → vision is mandatory.** The real skeleton lives in the creative image, not the text fields.
- **Static vs video is detectable at pull time → route at ingestion.** `video_duration>0` ⇒ video; corroborated by `ads_type=2` / `resource_urls[].type=2`. Several competitors are video-heavy (Everyday Dose pulls were all 53–115s video) — Phase 6 (video) carries real weight.
- **Query by `keyword` only.** The /explore UI's `niche`/`brand` filters are NOT in the API. Per-competitor pulls use the brand name AS the keyword.
- **`adsType` filters image/video/carousel** (`"1"`=image, `"2"`=video, `"3"`=carousel). The scout now passes **`adsType:["1"]` (image-only)** + `daysBack:90` + `pageSize:50` — founder 2026-07-17: "we aren't doing video stuff" (we research static creative). `searchAds` accepts `adsType?: string[]`.
- **⚠️ `/api/search` returns RECENT ads, NOT long-runners.** Empirically (2026-07-17) `/api/search` for a keyword returns only ads first-seen in the last ~8 days regardless of `daysBack`/`pageSize`, and `sortField` (`like|share|comment|impression|time` — NO days/longevity option) doesn't change which ads come back. So the "0 ads for a real brand" signal was a FALSE bad-seed flag (e.g. "Obvi collagen" returns 38–60 ads live but our DB had 0 — the sweep only saw new ads, which the winner/longevity filter then rejected). The **proven-winner** (long-running) ads live behind the advertiser endpoints: `GET /api/advertisers/search?q={brand}` (free → Meta page id) → `POST /api/winners/advertiser/{pageId}` (10 credits → scans the FULL library, surfaces + scores winning ads). Switching competitor-ad collection to that flow is the real fix for surfacing long-runners (spec-worthy).

## Rate limits + credits

- **1 credit/search · 10 searches/min · 10k/day.** The sweep `step.sleep`s ~7s between searches and dedups by `ad_key` so re-runs don't re-spend.

## Where it lands

| Table | What |
|---|---|
| [[../tables/creative_skeletons]] | One row per analyzed winner (structure + creative link) |

## Related
[[../libraries/adlibrary]] · [[../libraries/creative-skeleton]] · [[../inngest/creative-finder]] · [[anthropic]] (vision) · [[meta-graph]] (the KYC-gated alternative) · [[../specs/winning-static-creative-finder]]
