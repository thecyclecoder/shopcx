/**
 * Ad tool — Whisper word-level transcription (captions source).
 *
 * Sends the talking-head audio to OpenAI Whisper with word-level timestamps so
 * the Hormozi caption layer can sync each word exactly. Persisted on
 * ad_videos.transcript_json. Uses the existing OPENAI_API_KEY.
 */
// .trim() defends against a trailing newline/space on the env value (a classic
// dashboard-paste mistake) — an untrimmed key makes the Bearer header invalid and
// OpenAI returns 401 even though the key itself is correct.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim();

/** Whisper rejects files over 25 MB — gate before posting so we fail soft, not 413. */
export const WHISPER_MAX_BYTES = 25 * 1024 * 1024;
/** Whisper pricing: $0.006/min = 0.6 cents/min (Apr 2026; may drift). */
const WHISPER_CENTS_PER_MINUTE = 0.6;

export function hasOpenAiKey(): boolean {
  return !!OPENAI_API_KEY;
}

/** Estimated Whisper transcription cost in cents for a given audio duration. */
export function whisperCostCents(durationSec: number): number {
  return (Math.max(durationSec, 0) / 60) * WHISPER_CENTS_PER_MINUTE;
}

export interface TranscriptWord {
  word: string;
  start: number; // seconds
  end: number;
}

export interface Transcript {
  words: TranscriptWord[];
  text: string;
  duration: number;
}

/** Transcribe an audio URL into word-level timestamps. */
export async function transcribeWords(audioUrl: string): Promise<Transcript> {
  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) throw new Error(`audio_fetch_${audioRes.status}`);
  const buffer = Buffer.from(await audioRes.arrayBuffer());
  return transcribeBuffer(buffer, "audio.mp3", audioRes.headers.get("content-type") || "audio/mpeg");
}

/**
 * Transcribe already-downloaded media bytes (audio OR video — Whisper extracts the
 * audio track itself). Used by the creative-finder video pipeline, where the source
 * lives behind an authenticated AdLibrary URL so we must fetch the bytes ourselves
 * (a raw URL fetch 403s) and hand Whisper the buffer. `filename`'s extension drives
 * Whisper's format detection, so pass a realistic one (e.g. "ad.mp4").
 */
export async function transcribeBuffer(
  buffer: Buffer,
  filename: string,
  mimeType = "video/mp4",
): Promise<Transcript> {
  if (!OPENAI_API_KEY) throw new Error("no_openai_key");
  if (buffer.byteLength > WHISPER_MAX_BYTES) throw new Error("whisper_file_too_large");

  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(buffer)], { type: mimeType }), filename);
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`whisper_${res.status}`);
  const json = await res.json();
  const words: TranscriptWord[] = (json.words || []).map((w: any) => ({ word: w.word, start: w.start, end: w.end }));
  return { words, text: json.text || "", duration: json.duration || (words.at(-1)?.end ?? 0) };
}
