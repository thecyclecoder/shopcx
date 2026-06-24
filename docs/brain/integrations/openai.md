# openai

OpenAI — two narrow uses: **embeddings** (the main one) and **Whisper audio transcription**. **Not used for chat/completions** — that's Anthropic ([[anthropic]]). The transcription side powers ad captions ([[../libraries/ad-transcribe]]) and the creative-finder video pipeline ([[../libraries/video-skeleton]] · [[../specs/creative-finder-video]]).

## Auth

- **Env only:** `OPENAI_API_KEY` (account-level)

No per-workspace credentials. Embeddings are workspace-agnostic — the same model produces the same vector for the same text regardless of which workspace's tenant data we're embedding.

## SDK

Uses the official `openai` npm SDK. Initialized in `src/lib/embeddings.ts`.

## Key calls

| Call | Purpose |
|---|---|
| `embeddings.create({ model: "text-embedding-3-small", input })` | Embed a string or string[] → 1536-dim vector |
| `POST /v1/audio/transcriptions` (`whisper-1`, `verbose_json`) | Word-level transcription — ad captions + creative-finder video transcripts ([[../libraries/ad-transcribe]]) |

No other OpenAI endpoint is in production use.

## Where embeddings get stored

| Table | What we embed |
|---|---|
| [[../tables/kb_chunks]] | Knowledge base article chunks for RAG |
| [[../tables/macros]] | Macro template body for similarity search |
| [[../tables/smart_patterns]] | Smart pattern phrases (layer 2 of the 3-layer classifier) |

Stored in pgvector `vector(1536)` columns. Retrieved with `<=>` cosine distance. See `src/lib/rag.ts` for the unified retriever.

## Rate limits + retry

- 3000 RPM / 1M TPM on `text-embedding-3-small` by default (tier-dependent).
- SDK retries on 429 + 5xx with exponential backoff (built-in).
- Batch where possible: pass `input: string[]` (up to 2048 items / 8191 tokens per item) instead of one call per string. Used by [[../inngest/kb-embed]] for bulk article re-embedding.

## Multi-provider abstraction

`src/lib/embeddings.ts` is provider-agnostic at the call site:
```ts
const vector = await embed("some text");
```
The implementation currently uses OpenAI. A "use Voyage instead" flag exists but is untested in prod. The unified interface is what matters — never import the OpenAI SDK directly outside `embeddings.ts`.

## Gotchas

- **Don't use OpenAI for chat/completions.** Anthropic is the chat provider. Mixing providers across models would invalidate the prompt-caching strategy. See `AGENTS.md`.
- **`text-embedding-3-small` (1536d) is the locked model.** Switching models requires re-embedding every existing vector — `kb_chunks`, `macros`, `smart_patterns` all need a full backfill. Don't change casually.
- **Truncate input** to ~8000 chars before embedding. Long docs need chunking — see `src/lib/kb-chunker.ts`.
- **Don't normalize the returned vector.** OpenAI returns unit vectors already; double-normalizing wastes cycles.

## Files

- `src/lib/embeddings.ts` — Single entry point; never import OpenAI SDK elsewhere
- `src/lib/rag.ts` — pgvector retrieval (KB + macros)
- `src/lib/kb-chunker.ts` — Article chunking
- `src/lib/inngest/kb-embed.ts` — Bulk embed pipeline for new / updated KB articles
- `src/lib/pattern-matcher.ts` — 3-layer classifier (uses embeddings in layer 2)

## Related

[[../tables/kb_chunks]] · [[../tables/macros]] · [[../tables/smart_patterns]] · [[../tables/knowledge_base]] · [[anthropic]] · [[../inngest/kb-embed]] · [[../libraries/ad-transcribe]] · [[../libraries/video-skeleton]] · [[../specs/creative-finder-video]]
