# libraries/next-order-journey-builder

The next-order journey builder. Loads current subscriptions from all linked accounts and renders the subscription editor steps (subscription select → editor).

**File:** `src/lib/next-order-journey-builder.ts`

## File header

```
Build next-order journey steps for subscription editor.
Delegates from the switch in journey-step-builder.
Live-rendered on each load — reads active + paused subscriptions and workspace catalog.
```

## Exports

### `buildNextOrderJourneySteps` — function

```ts
async function buildNextOrderJourneySteps(workspaceId: string, customerId: string, ticketId: string,) : Promise<{ steps: NextOrderJourneyStep[]; metadata: NextOrderJourneyMetadata }>
```

### `NextOrderJourneyStep` — interface

Step shape for the editor flow.

### `NextOrderJourneyMetadata` — interface

Journey metadata (customer, workspace, selected subscription).

### `NextOrderSubscription` — interface

Subscription row with editable line items and billing info.

### `NextOrderEditableItem` — interface

A subscription line item (title, variant, quantity, price).

### `NextOrderCatalogVariant` — interface

Product catalog entry for the editor's add-item dropdown.

## Callers

- `src/lib/journey-step-builder.ts` — `next_order` switch case

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
