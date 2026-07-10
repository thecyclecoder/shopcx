# libraries/internal-subscription

Internal-subscription path (`is_internal=true`). Mutations are pure DB updates; no Appstle calls. Future home of the in-house billing-tick scheduler. See [[../lifecycles/subscription-billing]].

**File:** `src/lib/internal-subscription.ts`

## File header

```
Internal subscription engine.
Subscriptions with `is_internal = true` are managed entirely by
shopcx — no Appstle in the loop. Every Appstle helper checks the
flag and, if set, delegates to one of the handlers below. Same
function signatures + return shape as Appstle so callers don't
branch (the existing portal UI, the action_executor's direct
actions, the Sonnet-orchestrator paths — all work unchanged).
State the handlers mutate:
subscriptions.status                 active | paused | cancelled
subscriptions.next_billing_date      ISO date string
subscriptions.billing_interval       day | week | month | year (lowercase per our DB convention)
subscriptions.billing_interval_count integer
subscriptions.items                  JSONB array of line items
subscriptions.applied_discounts      JSONB array
subscriptions.pause_resume_at        ISO timestamp (for timed pauses)
Anything that requires a Braintree charge (attemptBilling) is
stubbed for now — the renewal scheduler lands in a future commit.
```

## Exports

### `isInternalSubscription` — function

```ts
async function isInternalSubscription(workspaceId: string, contractId: string) : Promise<boolean>
```

### `internalSubscriptionAction` — function

```ts
async function internalSubscriptionAction(workspaceId: string, contractId: string, action: "pause" | "cancel" | "resume",) : Promise<ActionResult>
```

### `internalSubSkipNextOrder` — function

```ts
async function internalSubSkipNextOrder(workspaceId: string, contractId: string) : Promise<ActionResult>
```

### `internalSubUpdateBillingInterval` — function

```ts
async function internalSubUpdateBillingInterval(workspaceId: string, contractId: string, interval: "DAY" | "WEEK" | "MONTH" | "YEAR", intervalCount: number,) : Promise<ActionResult>
```

### `internalSubUpdateNextBillingDate` — function

```ts
async function internalSubUpdateNextBillingDate(workspaceId: string, contractId: string, date: string,) : Promise<ActionResult>
```

### `internalSubAddItem` — function

```ts
async function internalSubAddItem(workspaceId: string, contractId: string, variantId: string, quantity: number,) : Promise<ActionResult>
```

### `internalSubAddOneTimeGift` — function

```ts
async function internalSubAddOneTimeGift(
  workspaceId: string, contractId: string, variantId: string, quantity: number,
  opts: { free?: boolean; priceCents?: number | null } = {},
) : Promise<ActionResult>
```

Append a **one-time** item to the sub's next renewal that ships once then drops off. Always appends a NEW line (never merges) so the gift sits alongside a recurring line for the same variant. `opts.free` defaults **true** → `is_gift:true` ($0 via the [[pricing]] engine); paid → `price_override_cents` from `priceCents` (or omitted → live catalog price). Every line carries `one_time_next_renewal:true`, which the [[../inngest/internal-subscription-renewals]] engine drops after the order ships. Requires the sub be `active`. Called by [[subscription-items]] `subAddOneTimeGift` (internal branch).

### `buildOneTimeGiftItem` — function (pure)

```ts
function buildOneTimeGiftItem(
  resolved: ResolvedVariant | null, fallbackVariantId: string, quantity: number,
  opts: { free?: boolean; priceCents?: number | null } = {},
) : Item
```

Pure record builder for the one-time line (free → `is_gift`; paid → `price_override_cents`; quantity floored ≥1; price clamped ≥0). Unit-tested in `internal-subscription.oneTimeGift.test.ts` (7 cases).

### `internalSubRemoveItem` — function

```ts
async function internalSubRemoveItem(workspaceId: string, contractId: string, variantId: string,) : Promise<ActionResult>
```

### `internalSubSwapVariant` — function

```ts
async function internalSubSwapVariant(workspaceId: string, contractId: string, oldVariantId: string, newVariantId: string, quantity?: number,) : Promise<ActionResult>
```

### `internalSubUpdateLineItemPrice` — function

```ts
async function internalSubUpdateLineItemPrice(workspaceId: string, contractId: string, variantId: string, basePriceCents: number,) : Promise<ActionResult>
```

### `internalSubApplyDiscount` — function

```ts
async function internalSubApplyDiscount(workspaceId: string, contractId: string, discountCode: string,) : Promise<ActionResult>
```

### `internalSubRemoveDiscount` — function

```ts
async function internalSubRemoveDiscount(workspaceId: string, contractId: string, discountCodeOrId: string,) : Promise<ActionResult>
```

### `internalSubNotYetSupported` — function

```ts
function internalSubNotYetSupported(action: string) : ActionResult
```

## Callers

- `src/lib/appstle.ts`
- `src/lib/subscription-items.ts` — every internal short-circuit for line-item mutations, plus `internalSubApplyDiscount` / `internalSubRemoveDiscount` under the `subscriptionApplyCoupon` / `subscriptionRemoveCoupon` dispatcher

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
