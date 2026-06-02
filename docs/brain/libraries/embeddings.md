# libraries/embeddings

Provider-agnostic embedding wrapper. Currently OpenAI `text-embedding-3-small` (1536d). See [[../integrations/openai]].

**File:** `src/lib/embeddings.ts`

## File header

```
Embedding generation for semantic pattern matching
Supports: OpenAI (text-embedding-3-small), Voyage AI, or HuggingFace
Configure via OPENAI_API_KEY, VOYAGE_API_KEY, or HF_TOKEN env vars
```

## Exports

### `generateEmbedding` — function

```ts
async function generateEmbedding(text: string, dimensions: number = 384) : Promise<number[] | null>
```

### `generateEmbedding1536` — function

```ts
async function generateEmbedding1536(text: string) : Promise<number[] | null>
```

### `generatePatternEmbedding` — function

```ts
async function generatePatternEmbedding(patternId: string, name: string, description: string | null, phrases: string[],) : Promise<boolean>
```

### `generateAllPatternEmbeddings` — function

```ts
async function generateAllPatternEmbeddings() : Promise<number>
```

## Callers

- `src/app/api/workspaces/[id]/patterns/generate-embeddings/route.ts`
- `src/lib/inngest/kb-embed.ts`
- `src/lib/rag.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
