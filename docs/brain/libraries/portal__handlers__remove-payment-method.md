# libraries/portal/handlers/remove-payment-method

Portal route: revoke a saved payment method the customer no longer wants on file.

**File:** `src/lib/portal/handlers/remove-payment-method.ts`
**Route:** `POST /api/portal?route=remove_payment_method` (aliases: `removePaymentMethod`, `removepaymentmethod`)

## Why

Ticket `9bc2e674` (G esposito) surfaced a product gap: the customer asked 4+ times to remove three duplicate saved Mastercards (all ending 9009). The portal previously only LISTED cards and ADDED new ones (via [[portal__handlers__payment-methods]] and [[portal__handlers__payment-method-update]]) — there was no delete/revoke path anywhere on `customer_payment_methods`, and the orchestrator's `switch_payment_method` action only changes the default, not removes a card. The AI extrapolated to "scroll to Payment Methods and remove the duplicates" — an instruction the portal could not fulfill, which is the root of the customer's repeated frustration. This handler + the paired `getPaymentMethods` orchestrator-tool wording fix closes that gap.

## Guardrails (deliberate customer-only / PCI stance)

- **Customer-only** — same auth+ban gate as every other portal handler. There is NO agent-side removal action; support cannot revoke a card on the customer's behalf, per the deliberate customer-only / PCI stance called out in the ticket. If a signed-out customer asks, the answer is "sign in and remove it there," not "we'll do it for you."
- **Braintree-vaulted cards only.** Shopify-Payments cards live in Shopify's vault; a local flip would be re-mirrored back by the `customer_payment_methods/update` webhook. Refuse with `not_removable_here` so the AI can direct the customer to her Shopify account page.
- **Blocked on active-subscription pin.** A card currently pinned to an active/paused *internal* subscription cannot be removed — losing it mid-cycle breaks the next renewal. Response is `409 pinned_to_active_subscription` with the offending `subscription_ids` so the caller can prompt the customer to switch that sub's card first (via [[portal__handlers__set-subscription-payment-method]]) or add a replacement.
- **Default promotion.** When the removed card was `is_default`, the most-recently-created active Braintree card belonging to anyone in the customer's link group is promoted to default in the same request.
- **Best-effort Braintree vault delete.** `gateway.paymentMethod.delete` is called; a missing/invalid token or gateway hiccup is logged but never blocks the local `status='removed'` flip — the local flag is what renewal + dunning read, and re-attempting a delete on a stale token would loop.

## Request / response

```ts
POST /api/portal?route=remove_payment_method
Body: { paymentMethodId: string }

// Success
{ ok: true, removed: { id, brand, last4 }, new_default_id: string | null, already_removed?: true }

// Errors (all `{ ok: false, error: <code>, … }`)
// 400 missing_paymentMethodId
// 400 not_removable_here   (provider !== "braintree")
// 401 not_logged_in
// 403 payment_method_not_in_group
// 404 customer_not_found | payment_method_not_found
// 409 pinned_to_active_subscription  (with pinned_subscription_ids: string[])
```

## Exports

### `removePaymentMethod` — const

```ts
const removePaymentMethod: RouteHandler
```

## Callers

- Registered in [[portal__handlers__index]] `routeMap` under `removePaymentMethod` / `removepaymentmethod` / `remove_payment_method`.
- No agent-side caller — deliberate PCI stance (customer-only).

## Related knowledge fix

The Sonnet orchestrator's `getPaymentMethods` tool output (`src/lib/sonnet-orchestrator-v2.ts`) previously told the AI "customer can add/remove/set-default there" as one blanket line, which was paraphrased into the false "remove duplicates via the portal" instruction that Shopify-Payments cards could never satisfy. It now distinguishes STOREFRONT-VAULTED (add + remove supported here) from SHOPIFY PAYMENT METHODS (must be removed via the customer's Shopify account page) and states the billing-safe truth about duplicate cards (dunning dedupes by last4 + expiry, so a duplicate never causes a double charge) so the AI can reassure without inventing a self-serve step.

## Gotchas

- The handler does NOT participate in `MUTATION_GATED_ROUTES` — the first-delivery gate is subscription-scoped, and wallet removal is customer-scoped (no `contractId` in the request).
- `already_removed: true` is returned on a repeat call (idempotent) instead of a 404 — a client's optimistic UI can safely retry after a network hiccup.
- A card belonging to a linked account in the same group is removable by any member of the group, matching how the wallet is presented across the linked profiles in [[portal__handlers__payment-methods]].

---

[[../README]] · [[../../CLAUDE]]
