# libraries/cancel-journey-builder

THE cancel journey builder. Loads subs (across linked accounts), detects first-renewal + shipping protection, loads reasons from `workspaces.portal_config.cancel_flow.reasons`.

**File:** `src/lib/cancel-journey-builder.ts`

## File header

```
Build cancel journey steps from customer subscriptions + remedies.
Code-driven journey: subscription select → reason → AI remedies → resolution.
```

## Exports

### `buildCancelJourneySteps` — function

```ts
async function buildCancelJourneySteps(workspaceId: string, customerId: string, ticketId: string,) : Promise<
```

### `CancelJourneyStep` — interface

### `CancelJourneyMetadata` — interface

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
