# libraries/meta/sync-spend

Daily Meta Ad spend rollup → [[../tables/daily_meta_ad_spend]].

**File:** `src/lib/meta/sync-spend.ts`

## File header

```
Meta ad spend sync: fetch daily spend per account from Marketing API
```

## Exports

### `syncMetaAdSpend` — function

```ts
async function syncMetaAdSpend(params: { workspaceId: string; adAccountId: string; // our DB ID metaAccountId: string; // Meta numeric ID accessToken: string; startDate: string; // YYYY-MM-DD endDate: string; // YYYY-MM-DD }) : Promise<
```

## Callers

- `src/lib/inngest/meta-sync.ts`
- `src/lib/inngest/today-sync.ts`

## Gotchas

- **All Graph reads go through [[meta__graph-retry]] `graphFetchJson`.** The local
  `graphGet` helper mirrors the pattern in [[meta__performance]]: build a v18 Graph
  URL with `access_token` + params, hand the fetch thunk to `graphFetchJson`. That
  gives daily-spend sync the same 4-attempt exponential-backoff ladder for HTTP 5xx
  / Graph transient codes as the object-grain insights ingest — so a one-off
  Facebook edge 504 gateway timeout is retried in-line and never surfaces to
  [[../inngest/today-sync]]. The raw-fetch `metaGraphRequest` in `src/lib/meta/api.ts`
  is no longer called from this file (retry ladder gap fixed via signature
  `vercel:9422061756e527f7`).
- **Errors carry `httpStatus`.** `graphError` in [[meta__graph-retry]] now attaches
  `res.status` alongside `metaCode`/`metaSubcode` so callers can classify edge 5xx
  even when Facebook returns HTML (no JSON body → `metaCode` is undefined).
  [[../inngest/today-sync]] uses this to demote exhaustion of `httpStatus >= 500` to
  `console.warn`.

---

[[../README]] · [[../../CLAUDE]]
