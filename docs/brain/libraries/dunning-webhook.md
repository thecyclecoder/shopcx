# libraries/dunning-webhook

Shopify `billing_attempt_failure` + `customer_payment_methods/*` webhook handlers. Creates [[../tables/dunning_cycles]] rows + fires Inngest events.

**File:** `src/lib/dunning-webhook.ts`

## File header

```
Handle Shopify customer_payment_methods/create and /update webhooks
When a customer adds or updates a payment method, check if they have active dunning cycles
and trigger recovery if so.
```

## Exports

### `handlePaymentMethodEvent` — function

```ts
async function handlePaymentMethodEvent(workspaceId: string, payload: Record<string, unknown>,)
```

## Callers

- `src/app/api/webhooks/shopify/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
