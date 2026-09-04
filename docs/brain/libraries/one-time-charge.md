# `src/lib/one-time-charge.ts`

Charge an existing customer for a **one-off order** against the card already
vaulted in Braintree, and get that order into Amplifier.

## Why it exists

We had two money paths and neither fit a one-off:

| path | what it does | why it didn't fit |
|---|---|---|
| [[internal-subscription-renewals]] | bills a subscription on its schedule | bills the WHOLE contract and advances the schedule |
| `src/app/api/checkout/route.ts` | takes a new checkout | needs a cart + a nonce; the customer has to do it |

The failing case (ticket `303ef89d`, Susan Hall): she asked for **one** box in
September and her usual **two** from November. `subscriptionOrderNow` on an
internal contract fires a renewal — it would have billed 2 boxes plus shipping
protection and moved her November date. The alternatives were a quantity-flip
raced against an async charge, or asking the customer to go do it herself.

## Signature

```ts
chargeOneTimeOrder({
  workspaceId, customerId,
  items: [{ variant_id, quantity, unit_price_cents? }],  // internal product_variants.id
  paymentMethodId?,                     // default: the customer's active default card
  shippingAddress?,                     // default: their most recent order's
  shippingCents?,                       // default 0
  sourceName?,                          // default "one-time-charge"
  reason?,
}): Promise<OneTimeChargeResult>
```

## Order of operations

Mirrors the checkout route's money path, minus the cart:

1. **Resolve the card** — `customer_payment_methods` filtered to
   `status='active'` with a Braintree token. Same filter the renewal uses: a
   card the customer removed is never charged, even if a stale
   `subscriptions.payment_method_id` still points at it.
2. **Resolve the items** — price / sku / title from `product_variants`. A
   variant with no price is rejected rather than charged at zero.
3. **Tax** — Avalara `SalesInvoice` with `commit: true` when the workspace has
   `avalara_enabled`. Guarded: a failure warns and proceeds at zero tax rather
   than blocking a charge the customer is expecting.
4. **Evidence before money** — a `pending` row in `transactions` BEFORE the
   sale, so a crash mid-flight still records that we tried to charge.
5. **The sale** — `gateway.transaction.sale({ paymentMethodToken, customerId,
   options: { submitForSettlement: true } })`.
6. **Patch** the transaction row to `succeeded` / `failed`.
7. **Insert the order** — `financial_status='paid'`, `source_name` separable in
   reporting. **If this insert fails we refund immediately**, the same way
   checkout does: a DB failure must never leave a customer billed for something
   no one can find.
8. **Push to Amplifier** — `createAmplifierOrder`, then stamp
   `amplifier_order_id` / `amplifier_received_at`, or `amplifier_last_error` on
   failure.

## Gotchas

- **Amplifier's line field is `unit_price_cents`, not `price_cents`.** It's
  optional, so passing the wrong name type-checks and silently sends the
  warehouse no unit price. Do not re-introduce a `as Parameters<...>` cast on
  the `createAmplifierOrder` call — that cast is what hid this the first time.
- **A failed Amplifier push is reported, not swallowed.** `amplifier_error` on
  the result means the customer PAID and the warehouse has nothing. The caller
  must not tell them it shipped.
- **The address mapper is lossy by design.** `orders.shipping_address` is
  Shopify-shaped; `toAvalaraAddress` returns `null` on a half-formed address so
  we quote no tax rather than commit a SalesInvoice against it. Pinned in
  `one-time-charge.test.ts`.
- **Catalog price is usually NOT what the customer pays.** Susan's K-Cups are
  $79.95 in the catalog and $59.96 on her subscription line — charging a
  one-time box at catalog would have billed her $20 over her own rate. Pass
  `unit_price_cents` from the subscription line whenever the one-off stands in
  for a subscription shipment. Off-catalog lines are recorded in
  `orders.payment_details.price_overrides` so an audit can tell a deliberate
  price from a stale-price bug.
- **Shipping defaults to $0.** Most one-time assists ship free; pass
  `shippingCents` when they shouldn't.

## Related

[[../integrations/braintree]] · [[../integrations/amplifier]] · [[../integrations/avalara]] ·
[[internal-subscription-renewals]] · [[../lifecycles/storefront-checkout]]
