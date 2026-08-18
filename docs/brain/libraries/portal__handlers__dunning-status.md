# libraries/portal/handlers/dunning-status

Portal dunning status display.

**File:** `src/lib/portal/handlers/dunning-status.ts`

## Exports

### `dunningStatus` — const

```ts
const dunningStatus: RouteHandler
```

## Callers

_No internal callers found via static scan._

## Gotchas

- **`payment_update_url` resolves through [[portal-urls]] `getPaymentMethodsUrl`** — OUR portal's `/payment-methods`, never `https://{shopify_myshopify_domain}/account`. A customer in dunning is exactly the customer most likely to follow this link, and the Shopify account page cannot update the card that our internal renewals actually charge (ticket `c969f235`).
- The `workspaces` lookup this handler used to do purely for that URL is gone; add one back only if you need a real workspace field.

---

[[../README]] · [[../../CLAUDE]]
