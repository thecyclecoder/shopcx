# inngest/creative-finder

The surviving **video drain** half of the retired creative-finder. The static/competitor SWEEP that used to live here (daily `0 9 * * *` + `ads/creative-finder.sweep`, `CATEGORY_SEEDS` + every-competitor-at-once) was **RETIRED 2026-07-12** in favor of the deliberate PER-PRODUCT scout ([[creative-scout]]). What remains downloads and deconstructs the videos the scout parks. See [[creative-scout]] · [[../lifecycles/creative-finder]].

**File:** `src/lib/inngest/creative-finder.ts`

## Functions

### `creative-finder-video-process`
- **Trigger:** cron `30 9 * * *` + event `ads/creative-finder.video` `{ workspaceId?, max? }`
- **Retries:** 1
- Phase 1 of [[../specs/creative-finder-video]]: drains each ad-tool workspace's `status='video_pending'` [[../tables/creative_skeletons]] backlog via [[../libraries/video-skeleton]] `processVideoPending` (download → ffmpeg keyframes + Whisper transcript → same four-slot skeleton; hook = opening frame + first spoken line). Each row flips to `analyzed`/`failed` → cost-bounded (no re-process). The [[creative-scout]] parks videos product-tagged, so `product_id` / `competitor_id` survive the update.
- **Gated** on `hasAdLibraryKey()` (download) + `hasFfmpeg()` (frames) → `{ skipped: "no_adlibrary_key" | "no_ffmpeg" }`; transcription is best-effort inside the pipeline (`hasOpenAiKey()`). Emits a Control-Tower heartbeat (`creative-finder-video-process` — **id unchanged through the retire** so tracking is uninterrupted). Returns `{ workspaces, totals: { pending, analyzed, failed, bytesDownloaded, whisperCents } }`. Fired on demand by POST `/api/ads/creative-finder { mode:"video" }`.

## Retired here (moved / dropped)

- `creative-finder-daily-cron` + `creative-finder-manual-sweep` → **replaced** by [[creative-scout]] (`creative-scout-weekly-cron` + `ads/creative-scout.sweep`, per-product, skeletons tagged with `product_id`/`competitor_id`).
- `CATEGORY_SEEDS` + `promoteFromCategorySweep` (category competitor auto-discovery) → **dropped** (fully deliberate — competitors chosen by hand). `loadApprovedCompetitorSeeds` (workspace-wide read) → **replaced** by `loadApprovedCompetitorsForProduct` ([[../libraries/competitors]]).
- `promoteWhitelistedPages` + `syncResearchUrlsFromCreatives` (Rhea's URL sensor) → **preserved**, now run per-workspace inside [[creative-scout]] + [[acquisition-research-cadence]].

## Tables written / read

- **Writes** [[../tables/creative_skeletons]]: `video_pending` rows → `analyzed` with the four-slot skeleton (via [[../libraries/video-skeleton]]); `ai_token_usage` (`creative_skeleton_video_vision`).
- **Reads** [[../tables/ad_campaigns]] (which workspaces use the ad tool).

## Gotchas

- **Video cover-frame ≠ static.** A video parks as `video_pending` and is only ever deconstructed here — never mistaken for an `analyzed` static. Trust `media_type`.
- Per-workspace failures are swallowed (`safeProcessVideos`) so one bad workspace doesn't fail the drain; counts surface in the return value.

---

[[../README]] · [[creative-scout]] · [[../integrations/adlibrary]] · [[../integrations/openai]] · [[../libraries/creative-skeleton]] · [[../libraries/video-skeleton]] · [[../libraries/ad-transcribe]] · [[../libraries/adlibrary]] · [[../libraries/competitors]] · [[../tables/creative_skeletons]] · [[competitor-scout]] · [[../specs/creative-finder-video]] · [[../../CLAUDE]]
