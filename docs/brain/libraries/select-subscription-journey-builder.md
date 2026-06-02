# libraries/select-subscription-journey-builder

Builds the subscription picker step. Used by cancel journey + playbooks when disambiguation needed.

**File:** `src/lib/select-subscription-journey-builder.ts`

## File header

```
Select Subscription Journey Builder
Lightweight picker — shows subscription cards, customer picks one.
Returns the subscription ID to the calling workflow/playbook.
Only used when there are 2+ applicable subscriptions.
```

## Exports

### `buildSelectSubscriptionSteps` — function

```ts
async function buildSelectSubscriptionSteps(admin: Admin, workspaceId: string, customerId: string, ticketId: string, filterStatuses?: string[], // e.g. ["active"] or ["paused", "cancelled"]) : Promise<BuiltJourneyConfig>
```

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
