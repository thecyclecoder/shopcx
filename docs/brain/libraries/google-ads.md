# libraries/google-ads

Google Ads API client (read campaigns + spend).

**File:** `src/lib/google-ads.ts`

## File header

```
Google Ads Keyword Planner API client.
Uses REST API (not the Node.js client library) to keep the bundle small.
Auth: OAuth2 with refresh token → access token.
Endpoint: KeywordPlanIdeaService.GenerateKeywordIdeas
```

## Exports

### `generateKeywordIdeas` — function

```ts
async function generateKeywordIdeas(workspaceId: string, seedKeywords: string[], language?: string, country?: string,) : Promise<KeywordIdea[]>
```

### `KeywordIdea` — interface

## Callers

- `src/lib/inngest/seo-keyword-research.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
