# libraries/customer-demographics

Census + Versium demographic enrichment. Writes [[../tables/customer_demographics]].

**File:** `src/lib/customer-demographics.ts`

## File header

```
Customer demographic analysis — pure logic (no AI, no external calls).
Derives buyer_type, health_priorities, and spend stats from order and
subscription history. Life stage is left to the orchestrator (needs
name inference age range).
```

## Exports

### `analyzeOrderHistory` — function

```ts
function analyzeOrderHistory(orders: OrderInput[], subscriptions: SubscriptionInput[],) : OrderDemographics
```

### `lifeStageFromAgeRange` — function

```ts
function lifeStageFromAgeRange(age: AgeRange | null | undefined) : LifeStage
```

### `HEALTH_PRIORITY_KEYWORDS` — const

```ts
const HEALTH_PRIORITY_KEYWORDS: Array<{
  priority: string;
  keywords: string[];
}>
```

### `OrderInput` — interface

### `SubscriptionInput` — interface

### `OrderDemographics` — interface

### `BuyerType` — type

### `LifeStage` — type

### `AgeRange` — type

## Callers

- `src/lib/inngest/customer-demographics.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
