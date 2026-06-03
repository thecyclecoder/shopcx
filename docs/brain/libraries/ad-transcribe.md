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

Fetches the audio, posts it to `POST /v1/audio/transcriptions` with `model=whisper-1`, `response_format=verbose_json`, `timestamp_granularities[]=word`, and returns the per-word timeline.

## Callers

- `src/lib/inngest/ad-tool.ts` — `adToolRenderRequested` transcribes once, reuses across all 4 formats

## Gotchas

- Word-level timestamps require `verbose_json` AND the `word` granularity param — `text`/`json` formats won't return them.
- Throws on missing key (`no_openai_key`) / fetch failure; the render function catches and falls back to an empty transcript (captions simply absent).

---

[[../README]] · [[../../CLAUDE]]
