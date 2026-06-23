# Winning Static-Creative Finder ✅

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

## Phase 1 — Skeleton store ✅
- ✅ `creative_skeletons` table (`supabase/migrations/20260619220000_creative_skeletons.sql`) — one row per analyzed winner: `source`, `dedup_key` (AdLibrary `ad_key`, unique per workspace+source), `advertiser`, `image_url`, `media_type`, `format`, `framework`, the four slots `hook`/`mechanism_claim`/`proof`/`offer`, plus `days_running`, `heat`, `first_seen`/`last_seen`/`resume_advertising`, `seed_keyword`/`seed_kind`, `status`, `raw`. RLS = member-read + service-write. (Structure + image link only, never a lifted asset.) Brain: [[../tables/creative_skeletons]].

## Phase 2 — Discovery (AdLibrary.com) ✅
- ✅ `src/lib/adlibrary.ts` — `searchAds({ keyword, appType:'3', geo:['USA'], daysBack, pageSize })`; `fetchCreative(url)` sends the Bearer key; `isLongRunner()` (days_count + resume flag); `classifyMedia()` routes static vs video at pull time. Brain: [[../libraries/adlibrary]] · [[../integrations/adlibrary]].
- ✅ **Seed list** (`CATEGORY_SEEDS` + `COMPETITOR_SEEDS` + `ALL_SEEDS`): Amazing Coffee → `everydaydose`, `ryze`, `lifeboost`, `urthlabs`/`erthlabs`, `leanjoebean`, `atlascoffeeclub`, `piquelife`, `mudwtr`; Ashwavana → `onnit`; greens cross → `bloomnu`; plus category keywords across inflammation/energy/longevity/weight-loss/anti-aging.

## Phase 3 — Vision deconstruction ✅
- ✅ `src/lib/creative-skeleton.ts` `visionDeconstruct()` + `ingestAd()`: fetch image (Bearer) → **Claude vision (Opus)** → `{ format, framework, hook, mechanism_claim, proof, offer }` → upsert `creative_skeletons`. Dedup by `ad_key` (skipped before any vision spend). Videos routed to `status='video_pending'` (no vision). Brain: [[../libraries/creative-skeleton]].

## Phase 4 — Pattern matrix (the deliverable) ✅
- ✅ `buildPatternMatrix()` — clusters each slot's values across rows (token-overlap) and keeps clusters spanning **≥N _independent_ brands** (distinct `advertiser`); brand count is the score, longevity the tiebreak. Deterministic (no per-load LLM spend).
- ✅ Emits a ranked `testMatrix`: hook × mechanism × proof × offer combos scored by summed cross-brand repetition (top 25) — the consumable hand-off for variant-generation.

## Phase 5 — Surface + workflow ✅
- ✅ Dashboard `/dashboard/marketing/ads/winning` — **Pattern matrix** tab (slot patterns + supporting brands + test matrix) and **Browse** tab (deconstructed winners with shortlist/archive). "Run sweep now" fires the manual event. Creatives display via an authenticated proxy (no re-hosting). API: `/api/ads/creative-finder` (list + POST sweep), `/patterns`, `/[id]` (shortlist), `/media` (proxy).
- ✅ Daily sweep cron + manual event: `src/lib/inngest/creative-finder.ts` (`creative-finder-daily-cron` `0 9 * * *` + `ads/creative-finder.sweep`), registered in `src/app/api/inngest/route.ts`. Brain: [[../inngest/creative-finder]].

## Phase 6 — Video (follow-on) — ✂️ split out
- **Split to [[creative-finder-video]] (2026-06-23 board-grooming).** The video pipeline is a separable, heavier follow-on that isn't needed now — moved to its own planned card so the static finder (Phases 1-5 ✅) is fully shipped. v1 already parks videos at `status='video_pending'`; nothing is lost, only deferred. See [[creative-finder-video]].

## Safety / invariants
- **Structure, not creative.** Reverse-engineer skeletons; store structure + an image link for analysis. Never republish or lift a competitor's asset.
- **Signal = repetition across independent brands**, never a single ad's metrics.
- `ADLIBRARY_API_KEY` in env (`.env.local` + Vercel), never committed; respect credits + rate limits (dedup by `ad_key`).
- No-orphan: owner = [[../functions/growth]], parent = the static-ad-optimization mandate.

## Completion criteria
- ✅ A daily sweep pulls long-running competitor + category ads (seed list + discovery), vision-deconstructs each into a skeleton, and produces a **test matrix of slot-patterns repeating across multiple independent brands** — browsable on the dashboard and consumable by variant-generation. Video handled in Phase 6 (deferred; videos are captured as `video_pending`).

## Go-live (owner) ⏳
Before the sweep produces data in prod:
1. **Apply the migration** — `npx tsx scripts/apply-creative-skeletons-migration.ts` (creates `creative_skeletons`). *(Gated — needs prod DB creds; the build box has none.)*
2. **Set `ADLIBRARY_API_KEY`** in Vercel env (Business-tier key; already in `.env.local` for local) so `hasAdLibraryKey()` is true. Until it's set the cron returns `{ skipped: "no_adlibrary_key" }`.
3. Open `/dashboard/marketing/ads/winning` → **Run sweep now** to seed the first batch (or wait for the `0 9 * * *` cron).

## Verification
- On `/dashboard/marketing/ads/winning`, click **Run sweep now** → expect a "Sweep queued" alert and, within a few minutes, the **Browse** tab to populate with deconstructed competitor skeletons (advertiser, hook/mechanism/proof/offer, days-running). *(Requires the migration applied + `ADLIBRARY_API_KEY` set.)*
- On the **Pattern matrix** tab, after ≥2 brands are analyzed → expect at least one slot card showing a pattern with an "N brands" badge, and (when ≥2 slots repeat) a populated test-matrix table ranked by score.
- In the **Browse** tab, click **☆ Shortlist** on a card → expect it to flip to "★ Shortlisted" and persist on reload (PATCH `/api/ads/creative-finder/[id]` → `status='shortlisted'`).
- A skeleton's creative image renders in Browse (served through `/api/ads/creative-finder/media?u=…`) → confirms the Bearer-keyed proxy works and no asset is re-hosted.
- Trigger the cron manually in the Inngest dashboard (`creative-finder-daily-cron`) → expect a return `{ workspaces, totals: { searched, longRunners, inserted, videos, skippedExisting, failed } }`; a second run shows `skippedExisting` rising (dedup by `ad_key` working, no re-spend).
- Verify a video competitor (e.g. `everydaydose`) lands rows with `media_type='video'`, `status='video_pending'`, and no vision spend → confirms Phase-6 routing.
- DB spot-check: `select advertiser, hook, mechanism_claim, days_running from creative_skeletons where status='analyzed' order by days_running desc limit 10;` → expect populated slots from long-running ads.

## Related
[[storefront-iteration-engine]] · [[killer-statics]] · [[advertorial-landers]] · [[../functions/growth]] · [[../integrations/adlibrary]] · [[../libraries/adlibrary]] · [[../libraries/creative-skeleton]] · [[../tables/creative_skeletons]] · [[../inngest/creative-finder]]
