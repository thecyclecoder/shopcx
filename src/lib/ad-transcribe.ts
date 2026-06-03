/**
 * Ad tool — Whisper word-level transcription (captions source).
 *
 * Sends the talking-head audio to OpenAI Whisper with word-level timestamps so
 * the Hormozi caption layer can sync each word exactly. Persisted on
 * ad_videos.transcript_json. Uses the existing OPENAI_API_KEY.
 */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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
  if (!OPENAI_API_KEY) throw new Error("no_openai_key");
  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) throw new Error(`audio_fetch_${audioRes.status}`);
  const blob = await audioRes.blob();

  const form = new FormData();
  form.append("file", blob, "audio.mp3");
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
