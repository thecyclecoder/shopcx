# libraries/rag

Unified RAG retriever — KB chunks ([[../tables/kb_chunks]]) + macros ([[../tables/macros]]) via pgvector. Returns ranked + de-duped results.

**File:** `src/lib/rag.ts`

## File header

```
RAG (Retrieval-Augmented Generation) for AI agent
Retrieves relevant KB chunks and macros for a given query
```

## Exports

### `retrieveContext` — function

```ts
async function retrieveContext(workspaceId: string, query: string, topK: number = 10,) : Promise<RAGContext>
```

### `RetrievedChunk` — interface

### `RetrievedMacro` — interface

### `RAGContext` — interface

## Callers

- `src/lib/ai-context.ts`
- `src/lib/inngest/unified-ticket-handler.ts`
- `src/lib/social-comment-orchestrator.ts`
- `src/lib/sonnet-orchestrator-v2.ts`

## Gotchas

- RAG retrieval combines KB chunks + macros and returns ranked + de-duped. Don't query the two tables separately.
- Embedding dimension is 1536 (`text-embedding-3-small`). Changing the model requires backfilling all vectors.

---

[[../README]] · [[../../CLAUDE]]
