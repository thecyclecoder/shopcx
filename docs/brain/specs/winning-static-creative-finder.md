# Winning Static-Creative Finder ⏳

**Owner:** [[../functions/growth]] · **Parent:** Growth mandate "Static-ad optimization"

**Reverse-engineer the STRUCTURE of winning ads — never copy the creative.** Pull long-running ads in our categories (inflammation / energy / longevity / weight-loss / anti-aging), strip each to its **skeleton** (hook → mechanism claim → proof → offer), and mine the **patterns that repeat across multiple *independent* brands** into a **test matrix**. Repetition across independent winners is the real signal — not any single ad. The output isn't an asset bin; it's a continuously-refreshed **structural pattern library + test matrix** that feeds variant-generation. First concrete spec under Growth's static-ad-optimization mandate.

**Strategist frameworks to detect/score against:** Hook → Promise → Proof · Problem → Pivot → Payoff (and variants). The engine should recognize which skeleton a winner uses and which slots repeat across brands.

## Source feasibility (tested 2026-06-19)
- ✅ **AdLibrary.com API works, no KYC.** `POST https://adlibrary.com/api/search`, `Authorization: Bearer ${ADLIBRARY_API_KEY}` (Business). Body: `{ keyword, appType:"3", geo:["USA"], daysBack, pageSize }`. Returns advertiser, `title`, scale (`all_exposure_value`/`impression`/`heat`) + longevity (`first_seen`/`last_seen`/`days_count`/`resume_advertising_flag`) + creative URLs. 1 credit/search, 10/min, 10k/day.
- ⚠️ **`body` copy is thin/empty → VISION IS MANDATORY.** The real skeleton lives in the creative image, not the text fields. Proven: an Everyday Dose ad had a blank `body` but vision extracted format+hook+mechanism+proof+offer cleanly.
- ⚠️ **Creative fetch needs the Bearer key** — `preview_img_url`/`resource_urls` (`adlibrary.com/api/media?u=…`) 403 without `Authorization: Bearer ${KEY}`; 200 with it.
- ⚠️ **Static vs video is detectable at pull time → route at ingestion.** `video_duration` (0 = static, >0 = video), corroborated by `ads_type` (1=image, 2=video) + `resource_urls[].type` (1/2). Statics → vision directly (Phase 3); video → frames+transcript (Phase 6). Note: several competitors are **video-heavy** (tested: all 12 Everyday Dose pulls were video, 53–115s), so Phase 6 carries real weight even though v1 is static-first.
- ✅ **Query by `keyword` only** — `/explore` UI's `niche`/`brand` filters are NOT in the API (tested: `brand` ignored). Per-competitor = `keyword`=brand name (tested: `onnit`→15 ads).
- ⛔ **Meta Ad Library API** — blocked behind `facebook.com/ID` identity confirmation (verified); a free alt only if the owner completes that KYC. AdLibrary is the path until then.

## Phase 1 — Skeleton store ⏳
- ⏳ `creative_skeletons` table — one row per analyzed winner: `source`, `dedup_key` (AdLibrary `ad_key`), `advertiser`, `image_url`, `format` (ugc | studio | text-card | before/after | demo | …), `framework` (hook-promise-proof | problem-pivot-payoff | …), and the four slots: `hook`, `mechanism_claim`, `proof`, `offer`; plus `days_running`, `heat`, `status`. (Reference/inspiration only — store the *structure* + image link, never a lifted asset.)

## Phase 2 — Discovery (AdLibrary.com) ⏳
- ⏳ `src/lib/adlibrary.ts` — `searchAds({ keyword, appType:'3', geo:['USA'], daysBack, pageSize })`; `fetchCreative(url)` sends the Bearer key. Pull **long-runners** (high `days_count` + `resume_advertising_flag`) by (a) category keywords and (b) per-competitor brand keyword.
- ⏳ **Competitor seed list** (curated + data-surfaced): **Amazing Coffee** → `everydaydose`, `ryze`, `lifeboost`, `urthlabs`/`erthlabs` (anti-aging = our match), `leanjoebean` (weight-loss = our match), `atlascoffeeclub`, `piquelife`, `mudwtr`; **Ashwavana** → `onnit`; **superfood/greens (cross)** → `bloom` (bloomnu). Daily category sweep auto-promotes new heavy advertisers.

## Phase 3 — Vision deconstruction ⏳
- ⏳ For each long-running creative: fetch the image (Bearer key) → **Claude vision** → extract the skeleton `{ format, framework, hook, mechanism_claim, proof, offer }` → write `creative_skeletons`. Dedup by `ad_key` (don't re-vision/re-spend).

## Phase 4 — Pattern matrix (the deliverable) ⏳
- ⏳ Aggregate skeletons → surface **slot patterns repeating across ≥N _independent_ brands** (e.g. "5 of 8 winners open on a UGC kitchen hook"; "6 brands lead mechanism with 'no jitters / clarity'"). Independent-brand repetition is the score, not single-ad performance.
- ⏳ Emit a **test matrix**: hook × mechanism × proof × offer combinations worth testing, ranked by cross-brand repetition + longevity of the ads exhibiting them. This is what feeds variant-generation.

## Phase 5 — Surface + workflow ⏳
- ⏳ Dashboard view: the **pattern matrix** (repeating slots, with the supporting independent winners + their images) + browse/shortlist. Hook for the variant-generation spec to pull shortlisted patterns.

## Phase 6 — Video (follow-on) ⏳
- ⏳ For `video_duration`>0: download → ffmpeg keyframes (dense in first ~3s) + transcribe audio → vision frames + transcript → same skeleton schema (literal first-2s hook = opening frame + first spoken line). Heavier pipeline (download + transcription cost) — separate phase.

## Safety / invariants
- **Structure, not creative.** Reverse-engineer skeletons; store structure + an image link for analysis. Never republish or lift a competitor's asset.
- **Signal = repetition across independent brands**, never a single ad's metrics.
- `ADLIBRARY_API_KEY` in env (`.env.local` + Vercel), never committed; respect credits + rate limits (dedup by `ad_key`).
- No-orphan: owner = [[../functions/growth]], parent = the static-ad-optimization mandate.

## Completion criteria
- A daily sweep pulls long-running competitor + category ads (seed list + discovery), vision-deconstructs each into a skeleton, and produces a **test matrix of slot-patterns repeating across multiple independent brands** — browsable on the dashboard and consumable by variant-generation. Video handled in Phase 6.

## Related
[[storefront-iteration-engine]] · [[killer-statics]] · [[advertorial-landers]] · [[../functions/growth]] · [[../integrations/meta]]
