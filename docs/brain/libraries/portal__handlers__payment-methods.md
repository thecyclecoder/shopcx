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

- **Lists STOREFRONT-VAULTED (Braintree) cards only** — the query carries `.eq("provider", "braintree")`. Shopify-Payments rows are deliberately excluded (ticket `c969f235`). They live in a vault we cannot write to, so every control the portal offers refuses them, and because the Braintree migration mirrors one physical card into BOTH vaults, listing them showed G esposito the SAME Mastercard ••9009 three times with a working Remove button on only one of them. This is a **display** change only: the renewal + dunning paths read `customer_payment_methods` directly, so legacy Shopify-Payments subscriptions still charge exactly as before.
- A customer whose ONLY saved card is Shopify-vaulted now sees an empty wallet with the "add a card" CTA. That is the intended nudge toward the Braintree vault as Shopify sunsets — not a bug.
- Read-only endpoint. Adding a card lives in [[portal__handlers__payment-method-update]]; **removing** a saved card lives in [[portal__handlers__remove-payment-method]] (Braintree-vaulted only, customer-only PCI stance).
- The customer-facing renderer is `src/app/portal/[slug]/_sections/PaymentMethodsSection.tsx`. Per-card Remove control (Phase 2 of the card-removal spec) is only shown on `provider === "braintree"` rows so a Shopify-Payments card never presents an affordance that is guaranteed to fail. Since the provider filter above, every row this handler returns is already Braintree — the UI guard stays as defense in depth against a future caller that widens the query. The button opens a confirm-then-fire panel (removal is irreversible from the customer's side) and POSTs to `/api/portal?route=removePaymentMethod`. Each refusal from [[portal__handlers__remove-payment-method]] renders as plain customer-facing language — `not_removable_here` → go to Shopify account; `pinned_to_active_subscription` → switch that sub's card first; `last_card_for_active_subscription` → add a replacement first. On success the row is dropped locally and a `new_default_id` in the response is reflected on the promoted sibling so the "Default" badge stays truthful without a reload.
- **Add-card decline mapping** — the same `PaymentMethodsSection.tsx` maps the ADD-card refusals returned by the `updatePaymentMethod` handler (which delegates to [[vault-and-migrate-payment-method]] → [[integrations__braintree-customer#vaultpaymentmethod]]) to plain-language guidance via `vaultRefusalMessage(code)`. Today: `vault_declined` → *"That card was declined. Please check the number, expiry, and CVV, or try another card."*, and `no_braintree_customer` → *"We couldn't set up your Braintree profile. Please refresh and try again."* The code-driven mapping is preferred over the server `message` so a future caller that forgets to include a message still shows the customer-fixable guidance instead of the opaque *"Couldn't save the card."* fallback. See [[../specs/classify-portal-vault-failed-card-declines-instead-of-escalating]] for why the previous behaviour (raw `502 { error: "vault_failed" }`) was escalating every processor decline to the CS Director.

---

[[../README]] · [[../../CLAUDE]]
