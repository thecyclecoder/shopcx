# libraries/kb-chunker

Splits KB articles into chunks for embedding.

**File:** `src/lib/kb-chunker.ts`

## File header

```
Document chunking for knowledge base articles
Splits content into ~500 token chunks (~2000 chars) with 50 token overlap (~200 chars)
```

## Exports

### `chunkDocument` — function

```ts
function chunkDocument(content: string) : Chunk[]
```

## Callers

- `src/lib/inngest/kb-embed.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
