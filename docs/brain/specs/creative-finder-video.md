# Creative Finder — Video (follow-on) ✅

**Priority:** critical

**Owner:** [[../functions/growth]] · **Parent:** [[winning-static-creative-finder]] (its video follow-on).
**Deferred:** split from [[winning-static-creative-finder]] by a board-grooming sweep (2026-06-23) — **not needed now.** The static-creative finder is fully useful on its own; video is a heavier, separable pipeline. v1 already routes videos to `status='video_pending'`, so **nothing is lost** — they're captured + queued for when this builds.

## Phase 1 — video creative deconstruction ✅
For AdLibrary creatives with `video_duration > 0` (parked at `status='video_pending'`): download → ffmpeg keyframes (dense in the first ~3s) + transcribe audio → run the frames + transcript through the **same four-slot skeleton schema** as statics (the literal first-2s hook = opening frame + first spoken line). Heavier pipeline (download + transcription cost) — that's why it was deferred to its own card. Brain: [[winning-static-creative-finder]] · [[../integrations/adlibrary]] · [[../integrations/openai]] · [[../libraries/video-skeleton]] · [[../libraries/creative-skeleton]] · [[../libraries/ad-transcribe]] · [[../tables/creative_skeletons]] · [[../inngest/creative-finder]].

What shipped:
- ✅ `src/lib/video-skeleton.ts` — `processVideoPending(workspaceId, {max})` drains `video_pending` rows; `deconstructVideo(workspaceId, creativeUrl)` does download (Bearer-keyed `fetchCreative`) → `extractKeyframes` (ffmpeg, offsets `[0,0.5,1,1.5,2,2.5,3,5,8,12]s` — dense in the first ~3s) → Whisper transcript → `visionDeconstructFrames`. Each row flips to `analyzed` (or `failed`), so an `ad_key` is never re-processed.
- ✅ `src/lib/creative-skeleton.ts` `visionDeconstructFrames(workspaceId, frames, transcript)` — same four-slot schema + frameworks as statics; the system prompt is extended so **hook = opening frame + first spoken line**. Logs `creative_skeleton_video_vision` usage.
- ✅ `src/lib/ad-transcribe.ts` `transcribeBuffer(buffer, filename, mime)` — buffer-based Whisper (the AdLibrary url 403s a raw fetch, so we hand Whisper the downloaded bytes); `whisperCostCents()` + `hasOpenAiKey()` + `WHISPER_MAX_BYTES` (25 MB gate). Transcription is best-effort — a silent/oversized clip still vision-analyzes on frames alone.
- ✅ ffmpeg via the bundled `ffmpeg-static` binary (`FFMPEG_PATH` env override); traced into `/api/inngest` + `serverExternalPackages` in `next.config.ts` so the binary survives Vercel's file-tracer.
- ✅ Inngest `creative-finder-video-process` (`src/lib/inngest/creative-finder.ts`, registered) — cron `30 9 * * *` (after the 9:00 static sweep) + event `ads/creative-finder.video {workspaceId?, max?}`. Gated on `hasAdLibraryKey()` + `hasFfmpeg()`; emits a Control-Tower heartbeat. POST `/api/ads/creative-finder { workspaceId, mode:"video" }` fires the event on demand.
- ✅ Cost-bounded + logged: per-ad `console.log` of `bytes / durationSec / frames / transcriptChars / whisperCents`; the function return carries `{ pending, analyzed, failed, bytesDownloaded, whisperCents }`.

## Go-live (owner) ⏳
1. **Set `OPENAI_API_KEY`** in Vercel (already used for embeddings/captions) — without it transcription is skipped and skeletons come from frames only.
2. ffmpeg ships via `ffmpeg-static` (bundled into the Inngest function); set `FFMPEG_PATH` only to override. With no ffmpeg the function returns `{ skipped: "no_ffmpeg" }` and rows stay `video_pending` (nothing lost).
3. Trigger `creative-finder-video-process` (Inngest dashboard) or POST `mode:"video"` → drains the `video_pending` backlog.

## Verification
- On the Inngest dashboard, run `creative-finder-video-process` (or POST `/api/ads/creative-finder { workspaceId, mode:"video" }`) → expect a return `{ workspaces, totals: { pending, analyzed, failed, bytesDownloaded, whisperCents } }`; afterwards a previously `video_pending` `creative_skeletons` row has `status='analyzed'`, `media_type='video'`, `visioned_at` set, and the four slots (`hook`/`mechanism_claim`/`proof`/`offer`) populated from keyframes + transcript.
- DB spot-check: `select advertiser, hook, mechanism_claim, proof, offer from creative_skeletons where media_type='video' and status='analyzed' order by days_running desc limit 10;` → expect the `hook` to read like the opening frame + first spoken line (the first-2s hook).
- Cost-bounded: run the processor twice → the second run shows `pending=0` for already-drained workspaces (rows are `analyzed`/`failed`, never re-downloaded/re-transcribed). The Inngest run logs carry a per-ad `[creative-finder-video] ad_key=… bytes=… durationSec=… whisperCents=…` line (download + transcription spend logged).
- Negative: a static creative is untouched by this path — `processVideoPending` only selects `status='video_pending'`; statics stay `analyzed` on the [[winning-static-creative-finder]] pipeline and the matrix is unchanged.
- Skip-safe: with `ADLIBRARY_API_KEY` unset → `{ skipped: "no_adlibrary_key" }`; with no ffmpeg binary → `{ skipped: "no_ffmpeg" }` and rows remain `video_pending`.
