# libraries/google-search-console

Google Search Console API client.

**File:** `src/lib/google-search-console.ts`

## File header

```
Google Search Console API client.
Retrieves search analytics (queries, clicks, impressions, CTR, position).
Auth: Service account JSON credentials stored encrypted in workspaces.
```

## Exports

### `getSearchAnalytics` — function

```ts
async function getSearchAnalytics(workspaceId: string, options?: { pageFilter?: string; // e.g. "/amazing-coffee" — filter to a specific page days?: number; // default 90 limit?: number; // default 100 },) : Promise<SearchQuery[]>
```

### `SearchQuery` — interface

## Callers

- `src/lib/inngest/seo-keyword-research.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
