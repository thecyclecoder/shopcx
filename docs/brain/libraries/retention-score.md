# libraries/retention-score

Computes retention score 0-100: recency 30%, frequency 25%, LTV 25%, subscription 20%.

**File:** `src/lib/retention-score.ts`

## Exports

### `calculateRetentionScore` — function

```ts
function calculateRetentionScore(customer: CustomerForScore) : number
```

### `updateRetentionScores` — function

```ts
async function updateRetentionScores(workspaceId: string) : Promise<void>
```

## Callers

- `src/app/api/customers/[id]/route.ts`
- `src/app/api/tickets/[id]/route.ts`
- `src/app/api/webhooks/appstle/[workspaceId]/route.ts`
- `src/lib/inngest/sync-shopify.ts`
- `src/lib/shopify-webhooks.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
