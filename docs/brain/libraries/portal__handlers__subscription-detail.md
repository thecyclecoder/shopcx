# libraries/portal/handlers/subscription-detail

Portal sub detail — items, recovery status, activity log.

**File:** `src/lib/portal/handlers/subscription-detail.ts`

## Exports

### `subscriptionDetail` — const

```ts
const subscriptionDetail: RouteHandler
```

## Callers

_No internal callers found via static scan._

## Gotchas

- **`paymentManageUrl` and `portalState.paymentUpdateUrl` both resolve through [[portal-urls]] `getPaymentMethodsUrl`** — they are the same URL and both point at OUR portal's `/payment-methods`. Before ticket `c969f235` the first was a hardcoded `https://account.superfoodscompany.com/profile` and the second was composed as `https://{shopify_myshopify_domain}/account`; both sent the customer to the Shopify account page, whose card vault we cannot write to. Never reintroduce a hardcoded host here.
- The handler still reads `workspaces.shopify_myshopify_domain`, but only to build the Shopify **Admin** GraphQL endpoint for the order lookup. That is an internal API call, not a customer-facing URL — do not repurpose it into a link.

---

[[../README]] · [[../../CLAUDE]]
