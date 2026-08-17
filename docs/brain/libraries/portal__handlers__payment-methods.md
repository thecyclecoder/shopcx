# libraries/portal/handlers/payment-methods

Portal list payment methods.

**File:** `src/lib/portal/handlers/payment-methods.ts`

## File header

```
Portal route: list the customer's saved payment methods. Read-only
for v1 — adding a new card vault requires the Braintree client-side
Hosted Fields integration which lands as a follow-up. The shape of
this endpoint is forward-compatible with the eventual mutations.
Returns ALL active payment methods on the customer + any linked
customer profiles. A linked account's saved cards are usable by the
shared person; the dunning pipeline already treats them as one
eligible pool, so the portal mirrors that.
Output shape:
{
ok: true,
methods: [{ id, brand, last4, expiration_month, expiration_year,
payment_type, is_default, provider, status }],
migrationEnabled: boolean,  // workspace flag — when true the UI
// shows the "add new card" CTA; when
// false the section is read-only.
}
```

## Exports

### `paymentMethods` — const

```ts
const paymentMethods: RouteHandler
```

## Callers

_No internal callers found via static scan._

## Gotchas

- Read-only endpoint. Adding a card lives in [[portal__handlers__payment-method-update]]; **removing** a saved card lives in [[portal__handlers__remove-payment-method]] (Braintree-vaulted only, customer-only PCI stance). SHOPIFY PAYMENT METHODS entries cannot be removed via the portal — the customer must remove them from her Shopify account page.
- The customer-facing renderer is `src/app/portal/[slug]/_sections/PaymentMethodsSection.tsx`. Per-card Remove control (Phase 2 of the card-removal spec) is only shown on `provider === "braintree"` rows so a Shopify-Payments card never presents an affordance that is guaranteed to fail. The button opens a confirm-then-fire panel (removal is irreversible from the customer's side) and POSTs to `/api/portal?route=removePaymentMethod`. Each refusal from [[portal__handlers__remove-payment-method]] renders as plain customer-facing language — `not_removable_here` → go to Shopify account; `pinned_to_active_subscription` → switch that sub's card first; `last_card_for_active_subscription` → add a replacement first. On success the row is dropped locally and a `new_default_id` in the response is reflected on the promoted sibling so the "Default" badge stays truthful without a reload.

---

[[../README]] · [[../../CLAUDE]]
