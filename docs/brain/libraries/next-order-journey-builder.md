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

## Total resolution — one money resolver, every engine

Subscription totals resolve through the ONE money resolver `priceSubscription` ([[commerce__price]]) for every engine — the same resolver the Portal / mini-site / reminder use. This ensures the journey editor shows the same total the customer will see at checkout and the Portal shows in the subscription detail.

For **internal subs**, lines are priced live via [[pricing]]. For **non-internal** (ShopCX/Appstle) subs, lines carry `price_cents`, so `priceSubscription` sums them (the old hand-sum of `items[].price` resolved ShopCX subs to no amount — a CEO 2026-11-23 bug fix). The total is `pricing.total_cents` (merchandise after discounts + shipping + protection). On `PriceInvariantError` (a line can't be priced), the builder falls back to the hand-sum rather than omitting the total (the reminder omits on error; the journey shows a fallback).

## Gotchas

None documented.

---

[[../README]] · [[../../CLAUDE]]
