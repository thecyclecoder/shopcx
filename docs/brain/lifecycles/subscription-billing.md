# Subscription billing

In-house recurring billing scheduler — the post-Appstle path. For internal subscriptions (`is_internal=true`) we own the contract, tax quote, charge, and order creation. For legacy Appstle subs we mirror state but Appstle still owns the charge. This page traces both paths and how they fail-over to dunning.

## Cast

- Internal: [[../inngest/internal-subscription-renewals]] cron + `src/lib/internal-subscription.ts`.
- Legacy: [[../integrations/appstle]] runs its own scheduler; we receive webhooks ([[../integrations/appstle]]).
- Tax: [[../integrations/avalara]].
- Payment: [[../integrations/braintree]] (paymentMethodToken vault).
- State: [[../tables/subscriptions]], [[../tables/orders]], [[../tables/transactions]].
- Dunning entry: [[../inngest/dunning]] (see [[dunning]]).

## Two paths

[[../tables/subscriptions]].`is_internal` decides:

- `true` — our scheduler. Braintree-charged. No Appstle calls.
- `false` — Appstle owns it. Appstle charges, sends webhooks, our state mirrors.

Every helper in `src/lib/appstle.ts` checks `isInternalSubscription()` first and short-circuits to `src/lib/internal-subscription.ts` for internal subs.

## Internal scheduler — Phase 1: tick selection

[[../inngest/internal-subscription-renewals]] runs hourly (`cron 0 * * * *`). For each workspace with `is_internal=true` subs:

```sql
SELECT * FROM subscriptions
WHERE workspace_id = ?
  AND is_internal = true
  AND status = 'active'
  AND next_billing_date <= now() + interval '1 hour'
```

Window is 1 hour so we have buffer + can amortize across the hour evenly via concurrency control.

## Internal scheduler — Phase 2: line item resolution

Pricing is **derived, never baked**. The renewal calls the pricing engine
([[../libraries/pricing]] · `resolveSubscriptionPricing`), which is the single
source of truth shared with the portal display. For each due sub:

1. **Resolve each line** from `subscription.items` JSONB — items are catalog
   **references** (variant + product UUIDs, quantity), not prices.
2. **Derive the price per line** = `base × (1 − quantity-break%) × (1 − S&S%)`,
   where `base` = `items[].price_override_cents` (grandfathered lock) ?? catalog
   `product_variants.price_cents`, the break is the **mix-and-match** tier for the
   total quantity sharing the line's [[../tables/pricing_rules]], and S&S is the
   rule's `subscribe_discount_pct` (else `workspaces.subscription_discount_pct`).
3. **Snapshot** the engine's per-line charged prices onto the order's line items
   (an order is a historical record, so it bakes the price; the sub never does).
4. **Apply discount** if `applied_discounts` JSONB has an active code. One coupon
   per sub — entire-order scope, on the product subtotal.
5. **Shipping** = free when a rule has `free_shipping` (internal subs are always
   subscription-mode, so the threshold doesn't gate it), else the sub's locked
   rate. **Protection** line if
   `shipping_protection_added=true` (passthrough; excluded from the discountable
   product subtotal). **Compute pre-tax total**.

## Internal scheduler — Phase 3: tax quote

Call [[../integrations/avalara]] `transactions/create`:

- type=SalesOrder (or SalesInvoice if we want to commit immediately).
- companyCode from [[../tables/workspaces]].`avalara_company_code`.
- addresses from the sub's shipping_address.
- lines from the resolved line items + their tax codes (resolved via [[../tables/product_variants]].`tax_code` or default).

Avalara returns the tax line. Cache on the sub's `avalara_quote_*` columns (matches the cart-time caching pattern from [[storefront-checkout]]).

## Internal scheduler — payment method

The renewal charges the sub's **pinned** card (`subscriptions.payment_method_id`,
set via the portal per-sub picker) if it's still active, otherwise the customer's
**default** `customer_payment_methods` row. The pin falls back automatically if the
card is removed (`ON DELETE SET NULL`). The portal sub-detail shows the same
resolution so the displayed card matches what's charged.

## Internal scheduler — Phase 4: charge

[[../integrations/braintree]] `transaction.sale`:

```ts
gateway.transaction.sale({
  paymentMethodToken: subscription.braintree_payment_method_token,
  customerId: subscription.braintree_customer_id,
  amount: (subtotal + tax + shipping) / 100,
  options: { submitForSettlement: true },
  externalVault: { previousNetworkTransactionId: subscription.last_braintree_txn_id }
})
```

`externalVault.previousNetworkTransactionId` is the SCA exemption signal — tells the issuer "this is a recurring charge in an established mandate, don't 3DS-challenge."

## Internal scheduler — Phase 5: outcome

### Success

1. Create [[../tables/transactions]] row: `type='subscription_renewal'`, `status='settled'`, `braintree_transaction_id`, `amount_cents`, `attempted_at`, `settled_at`.
2. Commit the Avalara transaction (type=SalesInvoice, commit:true) → records on Avalara's filing books.
3. Create [[../tables/orders]] row: `order_number` from `src/lib/order-number.ts`, line_items, total, financial_status='paid', subscription_id, customer_id, payment_details from Braintree response.
4. Update [[../tables/subscriptions]]:
   - `next_billing_date = current_next + billing_interval`.
   - `last_payment_status = 'settled'`.
   - `last_braintree_txn_id`.
5. Write [[../tables/customer_events]] `subscription.charged`.
6. Fire `order_placed` storefront event → CAPI fan-out ([[storefront-checkout]] Phase 7).
7. Tag the customer's most recent ticket (if any) with `wb` if this is a win-back. Otherwise no ticket change.

### Decline

1. Create [[../tables/transactions]] row: `type='subscription_renewal'`, `status='failed'`, `processor_response_code`, `processor_response_text`, `error_message`.
2. **Fire `dunning/payment-failed`** event → [[dunning]] takes over. Pass `subscription_id`, `customer_id`, error code, billing attempt id (we generate a synthetic id for internal subs since there's no Shopify billing_attempt to reference).
3. **Don't advance `next_billing_date`** — dunning will reset state on recovery.

## Legacy Appstle path

For `is_internal=false`:

- Appstle runs its scheduler invisibly to us.
- On success, Appstle webhook posts → we update [[../tables/subscriptions]] state + create [[../tables/orders]] (since the resulting Shopify order is what we mirror).
- On failure, Appstle webhook posts → our dunning-webhook handler creates a [[../tables/dunning_cycles]] row + fires `dunning/payment-failed`.
- All our subscription mutations go through `src/lib/appstle.ts` helpers, which internally check `is_internal` and bypass for internal subs.

## Migration path (Appstle → internal)

Not in production yet. Sketch:

1. Backfill `braintree_customer_id` + `braintree_payment_method_token` for existing Appstle subs by vaulting their card via Braintree (requires Card-on-File migration from the Shopify Payments gateway — non-trivial; Braintree has a vault import API for this).
2. Flip `is_internal=true` per sub in batches.
3. Cancel the corresponding Appstle contract (no `cancellationFeedback` — we own it now).
4. Watch [[../tables/transactions]] for the first internal charge.

Until cutover, the two paths coexist. Out of scope for this doc — see CLAUDE.md § Phase 7 + [[../lifecycles/storefront-checkout]] § subscription platform cutover.

## Pause / resume / skip — both paths

Customer-facing mutations are unified:

- Pause → `subscription.status='paused'`, `pause_resume_at` set if scheduled.
- Resume → `subscription.status='active'`, `pause_resume_at` cleared.
- Skip → `next_billing_date = next_billing_date + billing_interval` (skip one cycle).

For internal subs these are pure DB updates. For Appstle subs we also call Appstle. The helpers in `src/lib/appstle.ts` check `is_internal` and dispatch.

[[../inngest/portal-auto-resume]] runs every minute, picks up subs where `pause_resume_at <= now()`, calls `resume()`.

## Reactivating a cancelled subscription + manual price edits (money-safety)

**A cancelled subscription CAN be reactivated** — `cancelled → active` is supported, not just `paused → active`. Use `appstleSubscriptionAction(ws, contractId, "resume")`, which PUTs Appstle `subscription-contracts-update-status?status=ACTIVE`. The local row goes `cancelled → active` too.

These rules are non-obvious and a wrong move charges the customer immediately at the wrong price. Verified live on real win-back tickets (Susie 06-05, Kristin 06-08):

- **Modify first, activate LAST.** When reactivating a cancelled sub, set the line items, line prices, and next billing date **while it is still cancelled**, then flip to `active`. Activating first bills immediately under the stale conditions (old next-billing date, MSRP price). Gate every reactivation: verify the modified state, then activate.
- **Changing quantity RESETS the line price to MSRP.** `subChangeQuantity` goes through `replaceVariants` (remove + re-add); even with `carryForwardDiscount: "EXISTING_PLAN"` it drops the custom/grandfathered price (seen: $51.97 → $79.95). **Always re-assert the line price with `subUpdateLineItemPrice` after any quantity change.**
- **The base→charged relationship VARIES per contract — read the live price, never assume `/0.75`.** Some contracts apply the 25% selling-plan discount (`charged = base × 0.75`); others are flat-priced (`charged = base`, line `pricingPolicy: null`). To charge a target rate **G**: discounted contract → `base = round(G / 0.75)`; flat contract → `base = G`. Confirm by reading the live Appstle line `currentPrice`, **not** a formula and **not** the DB.
- **Billing-date slot is `08:00:00Z`** (store midnight Pacific). A bare `YYYY-MM-DD` becomes `T00:00:00Z` and Appstle snaps it a day early (asked 06-15, got 06-14). Pass the full `...T08:00:00Z`.
- **`"UserGeneratedError: The subscription contract has changed"` (HTTP 400) is transient** — it fires when a follow-up edit lands before a prior mutation (e.g. a quantity change) has settled. Retry once the contract settles.
- **The DB lags Appstle.** `subscriptions.items` / `subscriptions.next_billing_date` sync asynchronously and can show stale values right after a mutation — **verify against a live Appstle contract fetch**, not the local row.

## When dunning meets a charge

If a sub is in an active [[../tables/dunning_cycles]] when its `next_billing_date` rolls around:

1. The dunning cycle is the source of truth for retry timing — internal scheduler **skips** any sub with an active cycle that hasn't reached its scheduled payday-retry time.
2. When dunning succeeds, it fires `dunning/billing-success` which resets `next_billing_date` and resumes normal scheduler involvement.

This avoids double-charging during recovery.

## Tax handling on refunds

When a Braintree refund is issued via [[../inngest/returns]] → [[return-pipeline]], the Avalara transaction must be **voided** (or partial-adjusted) — else we over-remit tax to the state.

`refundBraintreeTransaction()` in `src/lib/integrations/braintree.ts` calls Avalara's `void` endpoint with the stored `avalara_transaction_code`. Full refund → DocVoided. Partial → adjustment transaction.

## Files touched

| File | Purpose |
|---|---|
| `src/lib/internal-subscription.ts` | Internal scheduler core |
| `src/lib/inngest/internal-subscription-renewals.ts` | Hourly cron |
| `src/lib/appstle.ts` | Appstle helpers with is_internal short-circuit |
| `src/lib/integrations/braintree.ts` | Gateway + transaction.sale + refund + void |
| `src/lib/avalara.ts` | Tax client |
| `src/lib/avalara-subscription.ts` | Sub-specific quote |
| `src/lib/avalara-tax-codes.ts` | Tax code lookup |
| `src/lib/order-number.ts` | Internal order number generator |
| `src/lib/customer-events.ts` | subscription.* event logging |
| `src/lib/inngest/portal-auto-resume.ts` | Pause auto-resume |
| `src/lib/billing-forecast.ts` | Forecast event writes (out of band) |

## Status / open work

**Shipped:** Both paths functional. Internal scheduler (hourly cron, line-item resolution, Avalara tax quote, Braintree charge, order create). Legacy Appstle path (webhook-driven, state mirroring, our subscription mutations dispatch on `is_internal`). Pause/resume/skip unified. Dunning integration. Tax void/adjust on refund.

**Known gaps / not yet shipped:**
- **Appstle → internal migration not activated.** Documented as the long-term plan; requires Braintree vault-import for Card-on-File migration off Shopify Payments. No live migration jobs running.
- Per `feedback_no_double_billing_framing` memory: customer comms must not frame parallel-sub charges as "double billing." That rule lives in sonnet_prompts, not in this lifecycle — but flag it for anyone touching billing UX.

**Recent activity:**
- `2bce67a4` Returns: refund instantly on delivered using stored net_refund_cents (touches transactions)
- `49cfd939` Orchestrator: add bill_now action + auto-fallback in change_next_date

**Open questions:**
- Trigger for starting the Appstle → internal migration: blocked on Braintree vault import or a policy decision?

## Related

[[storefront-checkout]] · [[dunning]] · [[return-pipeline]] · [[chargeback-pipeline]] · [[../integrations/appstle]] · [[../integrations/braintree]] · [[../integrations/avalara]] · [[../tables/subscriptions]] · [[../tables/orders]] · [[../tables/transactions]] · [[../tables/dunning_cycles]] · [[../inngest/internal-subscription-renewals]] · [[../inngest/portal-auto-resume]]
