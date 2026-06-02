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

_None documented._

---

[[../README]] · [[../../CLAUDE]]
