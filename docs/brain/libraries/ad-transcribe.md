# libraries/ad-transcribe

Ad tool — Whisper word-level transcription, the caption source. Sends the talking-head audio to OpenAI Whisper with word-level timestamps so the Hormozi caption layer can sync each word exactly. Persisted on `ad_videos.transcript_json`.

**File:** `src/lib/ad-transcribe.ts` · Uses the existing `OPENAI_API_KEY`. See [[../integrations/openai]], [[ad-render]].

## Exports

### `transcribeWords` — function

```ts
function transcribeWords(audioUrl: string): Promise<Transcript>

interface TranscriptWord { word: string; start: number; end: number } // seconds
interface Transcript { words: TranscriptWord[]; text: string; duration: number }
```

Fetches the audio, posts it to `POST /v1/audio/transcriptions` with `model=whisper-1`, `response_format=verbose_json`, `timestamp_granularities[]=word`, and returns the per-word timeline. (Now a thin wrapper: it fetches the bytes and delegates to `transcribeBuffer`.)

### `transcribeBuffer` — function

```ts
function transcribeBuffer(buffer: Buffer, filename: string, mimeType = "video/mp4"): Promise<Transcript>
```

Transcribe already-downloaded media bytes (audio OR video — Whisper extracts the audio track itself). Used by the creative-finder **video** pipeline ([[video-skeleton]] · [[../specs/creative-finder-video]]), where the source sits behind an authenticated AdLibrary url (a raw URL fetch 403s) so we fetch the bytes ourselves and hand Whisper the buffer. `filename`'s extension drives Whisper's format detection (pass e.g. `ad.mp4`).

### Helpers

- `hasOpenAiKey()` — gate for callers that make transcription best-effort.
- `whisperCostCents(durationSec)` — estimated spend (Whisper `$0.006/min`).
- `WHISPER_MAX_BYTES` — 25 MB; callers gate before posting so we fail soft, not 413.

## Callers

- `src/lib/inngest/ad-tool.ts` — `adToolRenderRequested` transcribes once, reuses across all 4 formats
- [[video-skeleton]] — `deconstructVideo` transcribes the downloaded video bytes (best-effort)

## Gotchas

- Word-level timestamps require `verbose_json` AND the `word` granularity param — `text`/`json` formats won't return them.
- Throws on missing key (`no_openai_key`) / fetch failure; the render function catches and falls back to an empty transcript (captions simply absent).

---

[[../README]] · [[video-skeleton]] · [[../integrations/openai]] · [[../specs/creative-finder-video]] · [[../../CLAUDE]]
