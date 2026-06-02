# libraries/pattern-matcher

3-layer classifier: keyword match → pgvector embedding → Claude Haiku fallback. Drives smart-tag application.

**File:** `src/lib/pattern-matcher.ts`

## Exports

### `matchPatterns` — function

```ts
async function matchPatterns(workspaceId: string, subject: string | null, body: string,) : Promise<PatternMatch | null>
```

### `PatternMatch` — interface

## Callers

- `src/lib/inngest/unified-ticket-handler.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
