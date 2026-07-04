# `src/lib/video-skeleton.ts` — video creative deconstruction

Phase 1 of [[../specs/creative-finder-video]] — the heavier follow-on to the static finder. The static sweep parks every video creative at `status='video_pending'` (no vision spend); this drains that backlog: **download → ffmpeg keyframes + Whisper transcript → the same four-slot skeleton as statics**, with the hook = opening frame + first spoken line. See [[creative-skeleton]] · [[ad-transcribe]] · [[../integrations/adlibrary]] · [[../integrations/openai]].

## Exports

| Export | Notes |
|---|---|
| `processVideoPending(workspaceId, { max=25 })` | Load `video_pending` [[../tables/creative_skeletons]] rows → `deconstructVideo` each → flip to `analyzed` (slots filled) or `failed`. Returns `VideoProcessResult`. The status flip IS the dedup — an `ad_key` is never re-processed |
| `deconstructVideo(workspaceId, creativeUrl)` | One creative: `fetchCreative` (Bearer download) → `transcribeBuffer` (best-effort) → `extractKeyframes` → `visionDeconstructFrames`. Returns `{ skeleton, frames, transcriptChars, durationSec, bytes, whisperCents }` |
| `extractKeyframes(videoBuffer)` | ffmpeg → JPEG frames at `KEYFRAME_OFFSETS_SEC` (`[0,0.5,1,1.5,2,2.5,3,5,8,12]` — dense in the first ~3s). Writes to a temp dir, one `-ss` seek per offset, always cleans up |
| `ffmpegBinary()` / `hasFfmpeg()` | Resolve the binary: `FFMPEG_PATH` env → bundled `ffmpeg-static`. The gate the Inngest fn checks |
| `VideoDeconstructResult` / `VideoProcessResult` | types |

## Cost / safety

- **Cost-bounded.** Only `video_pending` rows are picked, then flipped to `analyzed`/`failed` → no re-download / re-transcribe / re-vision. Per-ad spend is `console.log`ged (`bytes / durationSec / frames / transcriptChars / whisperCents`) and summed into `VideoProcessResult`.
- **Transcription is best-effort** — gated on `hasOpenAiKey()` + `WHISPER_MAX_BYTES` (25 MB). A silent / oversized / failing clip still vision-analyzes on the frames alone. The Whisper catch branch logs at `console.warn` (not `error`) so the Vercel log drain's `isError()` filter doesn't mint a Control Tower error_events row for a graceful degradation.
- **Structure, not creative** — same invariant as statics: we keep the skeleton + the AdLibrary link, never a lifted asset.

## Gotchas

- **ffmpeg must exist at runtime.** Defaults to the bundled `ffmpeg-static` binary; traced into `/api/inngest` + `serverExternalPackages` in `next.config.ts` so Vercel's file-tracer keeps it. No binary → the Inngest fn returns `{ skipped: "no_ffmpeg" }` and rows stay `video_pending` (nothing lost).
- **AdLibrary urls 403 a raw fetch** — the video bytes come through `fetchCreative` (Bearer key); we hand the buffer to Whisper (which extracts the audio track itself), never a URL.
- A per-offset ffmpeg failure (e.g. a seek past the clip end) is swallowed — that offset just yields no frame; one bad seek never fails the whole ad.
- The video row's `image_url` IS the video resource url (set by `ingestAd` at sweep time) — that's what `deconstructVideo` downloads.

## Callers

- [[../inngest/creative-finder]] (`creative-finder-video-process` — cron `30 9 * * *` + event `ads/creative-finder.video`).

## Related
[[creative-skeleton]] · [[ad-transcribe]] · [[adlibrary]] · [[../integrations/adlibrary]] · [[../integrations/openai]] · [[../integrations/anthropic]] · [[../tables/creative_skeletons]] · [[../inngest/creative-finder]] · [[../specs/creative-finder-video]] · [[../specs/winning-static-creative-finder]]
