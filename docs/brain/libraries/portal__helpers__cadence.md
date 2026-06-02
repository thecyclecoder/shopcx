# libraries/portal/helpers/cadence

Portal cadence (frequency) display helpers.

**File:** `src/lib/portal/helpers/cadence.ts`

## File header

```
Render a billing interval + count pair as the customer-friendly
label the pricing rules use ("Monthly", "Every 2 Months", etc.).
Mirrors the translateIntervals helper in playbook-executor.ts so
the portal, ticket replies, and operator scripts all read the same
language. When no friendly mapping exists, falls back to a
lowercase "every N weeks/months/days" sentence rather than the raw
"WEEK / 8" enum the Appstle webhook delivers.
```

## Exports

### `friendlyCadence` — function

```ts
function friendlyCadence(rawInterval: string | null | undefined, count: number | null | undefined) : string
```

## Callers

- `src/app/portal/[slug]/_sections/SubscriptionDetailScreen.tsx`
- `src/app/portal/[slug]/_sections/SubscriptionsSection.tsx`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
