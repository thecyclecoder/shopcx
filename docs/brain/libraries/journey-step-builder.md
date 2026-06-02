# libraries/journey-step-builder

Switch that delegates to per-journey builders (cancel, discount, crisis tiers, shipping-address, missing-items, select-subscription, account-linking).

**File:** `src/lib/journey-step-builder.ts`

## File header

```
Journey Step Builder
Builds interactive steps dynamically for code-driven journeys.
Used by both the mini-site GET API and the chat embedded form system.
One source of truth per journey type — never separately maintained.
```

## Exports

### `buildJourneySteps` — function

```ts
async function buildJourneySteps(workspaceId: string, journeyType: string, customerId: string, ticketId: string,) : Promise<BuiltJourneyConfig>
```

### `JourneyStep` — interface

### `BuiltJourneyConfig` — interface

## Callers

- `src/lib/crisis-journey-builder.ts`
- `src/lib/missing-items-journey-builder.ts`
- `src/lib/select-subscription-journey-builder.ts`
- `src/lib/shipping-address-journey-builder.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
