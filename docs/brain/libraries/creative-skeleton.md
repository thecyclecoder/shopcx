# `src/lib/creative-skeleton.ts` — vision deconstruction + pattern matrix

Phases 3 + 4 of the winning-static-creative finder. Vision-deconstructs a winner's creative into the four-slot skeleton and persists it, then aggregates skeletons into the cross-brand pattern matrix (the deliverable). See [[../specs/winning-static-creative-finder]].

## Exports

| Export | Notes |
|---|---|
| `visionDeconstruct(workspaceId, buffer, contentType)` | Claude vision (Opus) → `CreativeSkeleton \| null`. Logs `creative_skeleton_vision` usage. Strategist frameworks (hook-promise-proof / problem-pivot-payoff) baked into the system prompt |
| `visionDeconstructFrames(workspaceId, frames[], transcript)` | **Video** path ([[../specs/creative-finder-video]]): same four-slot schema + frameworks, fed ordered keyframes (earliest-first storyboard) + the audio transcript. System prompt extended so **hook = opening frame + first spoken line**. Logs `creative_skeleton_video_vision`. Used by [[video-skeleton]] |
| `sweepSeed(workspaceId, seed, opts?)` | search one seed → filter long-runners → dedup by `ad_key` → ingest. Returns `IngestResult` counts. `opts`: `minDays`/`maxPerSeed`/`daysBack`/`pageSize` |
| `ingestAd(workspaceId, ad, seed)` | vision (statics) + idempotent upsert into [[../tables/creative_skeletons]]; videos → `status='video_pending'` (no vision) |
| `buildPatternMatrix(workspaceId, { minBrands=2 })` | → `PatternMatrix`: `slotPatterns` (per-slot clusters repeating across ≥N **independent** brands) + ranked `testMatrix` (hook×mechanism×proof×offer) |
| `CreativeSkeleton` / `IngestResult` / `SlotPattern` / `TestMatrixRow` / `PatternMatrix` / `Slot` / `SLOTS` | types |

## How the matrix scores

- **Cluster** each slot's values across rows by greedy token-overlap (Jaccard ≥ 0.34), then keep only clusters spanning **≥ minBrands distinct `advertiser`s**. Brand count is the score; `maxDaysRunning` is the tiebreak.
- **Deterministic** (no per-load LLM spend) so the dashboard is cheap + reproducible.
- `testMatrix` = top patterns per slot crossed, ranked by summed brand counts (top 25).

## Gotchas

- **Vision is mandatory** — AdLibrary `body` is thin, so the skeleton must come from the image. `parseSkeleton` defends against stray fences/prose.
- **Dedup by `ad_key`** before vision → never re-vision/re-spend. `ingestAd` upserts on `(workspace_id, source, dedup_key)`.
- **Independent-brand repetition is the signal** — `heat`/`days_running` are never the score, only tiebreakers.
- Vision media type is coerced to a supported image mime (jpeg/png/gif/webp), defaulting to jpeg.

## Callers
- [[../inngest/creative-finder]] (`sweepSeed`).
- [[video-skeleton]] (`visionDeconstructFrames` — the video pipeline).
- `src/app/api/ads/creative-finder/patterns` (`buildPatternMatrix`).

## Related
[[adlibrary]] · [[../integrations/adlibrary]] · [[../integrations/anthropic]] · [[ai-models]] · [[ai-usage]] · [[../tables/creative_skeletons]] · [[../inngest/creative-finder]] · [[../specs/winning-static-creative-finder]]
