# `src/lib/creative-skeleton.ts` — vision deconstruction + pattern matrix

Phases 3 + 4 of the winning-static-creative finder. Vision-deconstructs a winner's creative into the four-slot skeleton and persists it, then aggregates skeletons into the cross-brand pattern matrix (the deliverable). See [[../lifecycles/creative-finder]] · [[../specs/winning-static-creative-finder]].

## Exports

| Export | Notes |
|---|---|
| `visionDeconstruct(workspaceId, buffer, contentType)` | Claude vision (Opus) → `CreativeSkeleton \| null`. Logs `creative_skeleton_vision` usage. Strategist frameworks (hook-promise-proof / problem-pivot-payoff) baked into the system prompt |
| `visionDeconstructFrames(workspaceId, frames[], transcript)` | **Video** path ([[../specs/creative-finder-video]]): same four-slot schema + frameworks, fed ordered keyframes (earliest-first storyboard) + the audio transcript. System prompt extended so **hook = opening frame + first spoken line**. Logs `creative_skeleton_video_vision`. Used by [[video-skeleton]] |
| `sweepSeed(workspaceId, seed, opts?)` | search one seed → filter long-runners → dedup by `ad_key` → ingest. Returns `IngestResult` counts. `opts`: `minDays`/`maxPerSeed`/`daysBack`/`pageSize`. Also best-effort upserts [[../tables/adlibrary_searches]] with `last_searched_at`/`last_result_count` after `searchAds` returns — the freshness ledger the Phase 2 gate ([[../specs/adlibrary-search-freshness-gate]]) reads to skip already-fresh seeds |
| `filterSeedsByFreshness(workspaceId, seeds, maxAgeDays?)` | Phase 2 freshness gate: reads [[../tables/adlibrary_searches]] and returns `{ kept, skipped }` — a seed is `kept` when its `last_searched_at` is NULL (never searched) OR older than `maxAgeDays` (default `ADLIBRARY_FRESHNESS_DAYS_DEFAULT`, override `ADLIBRARY_FRESHNESS_DAYS` env). Fail-open on DB error (returns all seeds). Applied in [[../inngest/creative-finder]] `creative-finder-daily-cron` BEFORE the `sweepSeed` loop and in `creative-finder-manual-sweep` unless the event fires with `force=true`. |
| `adlibraryFreshnessDays()` / `ADLIBRARY_FRESHNESS_DAYS_DEFAULT` | Reads `ADLIBRARY_FRESHNESS_DAYS` env override (positive integer) or falls back to the default constant. One knob — cron + manual sweep both read the same value. |
| `ingestAd(workspaceId, ad, seed)` | vision (statics) + idempotent upsert into [[../tables/creative_skeletons]]; videos → `status='video_pending'` (no vision) |
| `buildPatternMatrix(workspaceId, { minBrands=2 })` | → `PatternMatrix`: `slotPatterns` (per-slot clusters repeating across ≥N **independent** brands) + ranked `testMatrix` (hook×mechanism×proof×offer) |
| `CREATIVE_SHOTS_BUCKET` / `ensureCreativeShotsBucket()` / `uploadCreativeShot(path, buf)` / `signCreativeShot(path, ttl?)` | The private `creative-shots` bucket — our downscaled analyzable copy of each creative (what the dashboard displays; mirrors [[landing-page-scout]]'s `lander-shots`). |
| `CreativeSkeleton` / `IngestResult` / `SlotPattern` / `TestMatrixRow` / `PatternMatrix` / `Slot` / `SLOTS` | types |

## How the matrix scores

- **Cluster** each slot's values across rows by greedy token-overlap (Jaccard ≥ 0.34), then keep only clusters spanning **≥ minBrands distinct `advertiser`s**. Brand count is the score; `maxDaysRunning` is the tiebreak.
- **Deterministic** (no per-load LLM spend) so the dashboard is cheap + reproducible.
- `testMatrix` = top patterns per slot crossed, ranked by summed brand counts (top 25).

## Gotchas

- **Vision is mandatory** — AdLibrary `body` is thin, so the skeleton must come from the image. `parseSkeleton` defends against stray fences/prose.
- **Dedup by `ad_key`** before vision → never re-vision/re-spend. `ingestAd` upserts on `(workspace_id, source, dedup_key)`.
- **Independent-brand repetition is the signal** — `heat`/`days_running` are never the score, only tiebreakers.
- **Downscale before vision (`normalizeForVision`).** AdLibrary serves full-res source creatives (routinely 6–22MB) and its HTTP content-type is unreliable (reports jpeg for png bytes). Anthropic vision hard-rejects images >10MB (base64) — so EVERY creative is run through `sharp` (fit inside 1568px + re-encode JPEG) before the vision call, in BOTH `visionDeconstruct` (statics) and `visionDeconstructFrames` (video keyframes). This guarantees a supported `media_type` + under-limit bytes (a 22MB png → ~200KB jpeg, also slashing vision tokens). **Before this, every oversized static 400'd silently** (`vision_400`, swallowed) → `status='failed'` → the table stayed empty despite the cron running. The `contentType` arg to `visionDeconstruct` is no longer trusted. A creative sharp can't decode returns `null` (not visionable). Proven in `scripts/_raw-vision-fixed.ts`.
- **Display serves OUR stored copy, not a live proxy.** Even downscaling on-the-fly, the proxy still had to fetch the full-res source (6–22MB) from AdLibrary on EVERY image request → slow → 502. So `ingestAd` now uploads a downscaled **analyzable** copy (2048px q88, ~0.5MB) to the private `creative-shots` bucket (`ensureCreativeShotsBucket` / `uploadCreativeShot` / `signCreativeShot`) and persists `thumb_path` on the row ([[../tables/creative_skeletons]]); the list route returns a signed URL and the dashboard `<img>` hits Supabase storage directly. Kept high-quality (2048 > vision's 1568) so an operator can zoom + a future vision pass reads it. The media proxy ([[../../src/app/api/ads/creative-finder/media/route.ts]], now also 1440px-downscaled) survives only as a fallback for legacy rows without `thumb_path`. Backfill: `scripts/_backfill-creative-thumbs.ts`.

## Callers
- [[../inngest/creative-finder]] (`sweepSeed`).
- [[video-skeleton]] (`visionDeconstructFrames` — the video pipeline).
- `src/app/api/ads/creative-finder/patterns` (`buildPatternMatrix`).

## Related
[[adlibrary]] · [[../integrations/adlibrary]] · [[../integrations/anthropic]] · [[ai-models]] · [[ai-usage]] · [[../tables/creative_skeletons]] · [[../tables/adlibrary_searches]] · [[../inngest/creative-finder]] · [[../specs/winning-static-creative-finder]] · [[../specs/adlibrary-search-freshness-gate]]
