# adlibrary

**AdLibrary.com** — ad-intelligence index used to discover long-running competitor + category ads (the winners we reverse-engineer). Chosen because it works with **no KYC**, unlike Meta's Ad Library API which is gated behind facebook.com identity confirmation. See [[../specs/winning-static-creative-finder]] · client: [[../libraries/adlibrary]].

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

## Rate limits + credits

- **1 credit/search · 10 searches/min · 10k/day.** The sweep `step.sleep`s ~7s between searches and dedups by `ad_key` so re-runs don't re-spend.

## Where it lands

| Table | What |
|---|---|
| [[../tables/creative_skeletons]] | One row per analyzed winner (structure + creative link) |

## Related
[[../libraries/adlibrary]] · [[../libraries/creative-skeleton]] · [[../inngest/creative-finder]] · [[anthropic]] (vision) · [[meta-graph]] (the KYC-gated alternative) · [[../specs/winning-static-creative-finder]]
