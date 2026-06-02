# libraries/avalara-subscription

Quote tax for [[../tables/subscriptions]] at billing tick.

**File:** `src/lib/avalara-subscription.ts`

## File header

```
Avalara helpers for internal subscriptions:
• quoteSubscriptionTax(workspaceId, subscriptionId)
Calls Avalara `SalesOrder` (commit=false) — non-filing — and
saves the result to subscriptions.avalara_quote_*. Used by
the customer portal to show the actual renewal total.
• commitSubscriptionRenewalTax(workspaceId, subscriptionId, args)
Calls Avalara `SalesInvoice` (commit=true) using the renewal
order_number as the code. The returned tax_cents is the
authoritative tax the renewal will charge.
Both reuse `buildAvalaraLines` so the customer-displayed portal
tax and the renewal-charged tax stay in sync (Avalara is
deterministic for the same inputs).
Both gracefully no-op (return null tax) when Avalara isn't enabled
for the workspace — same convention as the checkout tax-quote
endpoint.
```

## Exports

### `quoteSubscriptionTax` — function

```ts
async function quoteSubscriptionTax(workspaceId: string, subscriptionId: string,) : Promise<
```

### `ensureFreshSubscriptionTaxQuote` — function

```ts
async function ensureFreshSubscriptionTaxQuote(workspaceId: string, subscriptionId: string,) : Promise<
```

### `commitSubscriptionRenewalTax` — function

```ts
async function commitSubscriptionRenewalTax(workspaceId: string, args: { subscriptionId: string; orderNumber: string; items: unknown; shippingAddress: unknown; shippingCents: number; shippingMethodLabel?: string; protectionCents: number; customerEmail: string | null; },) : Promise<
```

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
