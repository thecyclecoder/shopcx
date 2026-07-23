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

- **Comp (free) subs short-circuit to `{ tax_cents: 0, total_cents: 0 }`** in both
  `quoteSubscriptionTax` and `ensureFreshSubscriptionTaxQuote` — no Avalara call. A
  comp sub prices to a $0 taxable subtotal, which otherwise makes `buildTaxInputs`
  bail to `null`; the portal then renders a permanent "Calculating…" instead of a
  tax number. Origin: CEO's owner-comp sub. Pairs with [[commerce__price]]
  `resolveProtectionCents` (comp ⇒ $0 protection) so a comp sub reads fully $0.
- **`null` tax = "Calculating…" forever in the portal.** The portal
  ([[portal__handlers__subscription-detail]] → SubscriptionDetailScreen) shows
  "Calculating…" whenever `tax_cents` is null; there is no retry. A null return
  here (Avalara disabled, un-quotable inputs, or an Avalara error) is a stuck
  spinner, not a transient state — resolve to a concrete number wherever the tax
  is genuinely known (e.g. $0).

---

[[../README]] · [[../../CLAUDE]]
