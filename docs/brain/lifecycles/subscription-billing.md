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

Pricing is **derived, never baked** — **unless** the sub carries a configured grandfathered lock, in which case that lock is authoritative. The renewal calls the pricing engine
([[../libraries/pricing]] · `resolveSubscriptionPricing`), which is the single
source of truth shared with the portal display. For each due sub:

1. **Resolve each line** from `subscription.items` JSONB — items are catalog
   **references** (variant + product UUIDs, quantity), not prices — unless the item carries a lock (see below).
2. **Derive the price per line** = `base × (1 − quantity-break%) × (1 − S&S%)`,
   where `base` = `items[].price_override_cents` (grandfathered lock) ?? catalog
   `product_variants.price_cents`, the break is the **mix-and-match** tier for the
   total quantity sharing the line's [[../tables/pricing_rules]], and S&S is the
   rule's `subscribe_discount_pct` (else `workspaces.subscription_discount_pct`).
   **When an item carries a post-discount lock (`price_cents` set, no `price_override_cents`), rule decomposition is SKIPPED and `unit = price_cents` verbatim** — the sub's own configured per-unit is the authoritative renewal price. See the renewal-price contract in [[../libraries/pricing]] § The principle. This is what protects a grandfathered customer whose catalog price has since risen from silently being charged the current standard.
3. **Snapshot** the engine's per-line charged prices onto the order's line items
   (an order is a historical record, so it bakes the price; the sub never does).
4. **Apply discount** if `applied_discounts` JSONB has an active code. One coupon
   per sub — entire-order scope, on the product subtotal. `applied_discounts`
   stores bare **`{ code }` references**, not frozen values: each renewal
   `resolveRenewalDiscount` (coupons.ts) **live-reads** the code (Shopify
   `codeDiscountNodeByCode` → value + `recurringCycleLimit` + `appliesOncePerCustomer`/
   `usageLimit`), checks this customer's prior `coupon_redemptions` by code, applies
   if still valid, and **drops the code off the sub once its one-time/cycle limit is
   hit**. Redemptions are recorded only AFTER a successful charge (`record-coupon-
   redemptions` step). Appstle **automatic** discounts (Buy 3 / free shipping) carried
   on a migrated sub are silently dropped — our pricing rules own those. **Tax is
   quoted on the POST-coupon base** (line prices scaled by the coupon ratio for the
   Avalara quote only). (Sharon Mogliotti, 2026-06-12.)
5. **Shipping** = free when a rule has `free_shipping` (internal subs are always
   subscription-mode, so the threshold doesn't gate it), else the sub's locked
   rate. **Protection** line if
   `shipping_protection_added=true` (passthrough; excluded from the discountable
   product subtotal). **Compute pre-tax total**.

## Internal scheduler — Phase 2.5: overcharge guard (fail-safe)

Belt & suspenders to the configured-lock contract above. After line-item resolution and **before** coupon resolution / Avalara commit / pending-transaction insert / Braintree sale, the renewal calls [[../libraries/subscription-renewal-guard]] `checkRenewalOverchargeGuard(items, pricing.lines)`. Per product line, it compares the engine's computed `unit_cents` against that item's configured ceiling — `price_cents` if set, else `price_override_cents`, else uncapped (live-catalog opt-in). Gifts (unit $0 by design) and shipping protection (flag-billed, not a catalog line) never contribute.

If **any** product line's computed unit exceeds its ceiling — a divergence between what the engine computed and what the sub is configured for — the renewal is **HELD**:

- `emitRenewalOutcomeHeartbeat("skipped_other")` — outcome accounted for in Control Tower's distribution beats.
- [[../tables/customer_events]] `subscription.renewal_held_overcharge_guard` — subscription_id, reason (`overcharge_above_configured`), computed vs configured totals, offending lines.
- Return `{ skipped: true, reason: "overcharge_guard_held" }` — the charge is **NEVER** submitted to Braintree at the higher amount.
- `next_billing_date` is **intentionally NOT advanced** — a fix + re-run picks the sub back up on the next daily cron tick.

Why this exists: with the Phase 1 engine change (`price_cents` / `price_override_cents` flow through as the authoritative unit), a grandfathered customer's rate should never be exceeded — but if a future repricing regression reintroduces catalog decomposition on a locked line, this guard catches it before the customer is charged. Fail-safe: a grandfathered customer is never silently overcharged.

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
5. Create the **Amplifier fulfillment order** (`createAmplifierOrder`) with the priced line items — including a **Haiku-personalized founder note** on the packing slip (`buildPackingSlipMessage` → `claude-haiku-4-5`, same as the storefront checkout; non-fatal, falls back to the static template). Backfills `orders.amplifier_order_id`. Note: Amplifier's `normalizeAddress` accepts both snake_case and camelCase address shapes and only takes `country_code` from a real 2-letter code (never sliced from a country name).
6. Write [[../tables/customer_events]] `subscription.charged`.
7. Fire `order_placed` storefront event → CAPI fan-out ([[storefront-checkout]] Phase 7).
8. Tag the customer's most recent ticket (if any) with `wb` if this is a win-back. Otherwise no ticket change.

### Decline

1. Create [[../tables/transactions]] row: `type='subscription_renewal'`, `status='failed'`, `processor_response_code`, `processor_response_text`, `error_message`.
2. **Fire `dunning/payment-failed`** event → [[dunning]] takes over. Pass `subscription_id`, `customer_id`, error code, billing attempt id (we generate a synthetic id for internal subs since there's no Shopify billing_attempt to reference).
3. **Don't advance `next_billing_date`** — dunning will reset state on recovery.

## Comp subscriptions (free product — employee / influencer / investor / owner)

A **comp sub** ships free on schedule: base $0, **no saved payment method**, **no charge attempted**. Marker: [[../tables/subscriptions]].`comp=true` (with `is_internal=true` + every item `price_override_cents=0`). The allowlist + role live on [[../tables/customers]].`comp_role` (enum `employee｜influencer｜investor｜owner`, null = not comp-eligible) + `comp_note`.

**The $0-renewal gate (fail-closed).** A $0 renewal is **only** allowed for an allowlisted customer. [[../inngest/internal-subscription-renewals]] takes a dedicated comp branch (`load-comp-context`, **before** the normal load-context which hard-requires a PM):

1. **Gate first.** If the sub's customer has a null/invalid `comp_role` → **FAIL**: insert a `type='comp'` `status='failed'` transaction (`metadata.needs_attention=true`) + a `subscription.comp_renewal_failed` [[../tables/customer_events]] event, and **return without shipping or advancing**. Catches a $0 sub that shouldn't be free (misconfig, stale flag, abuse) instead of leaking product.
2. **Allowlisted → ship free.** Skip the `no_payment_method` early-return, skip the `totalCents<=0` (`zero_total`) skip, skip Braintree `transaction.sale`, skip Avalara + shipping pricing entirely. Resolve items via the pricing engine ($0 by override), then:
   - Create the renewal [[../tables/orders]] at `total_cents=0`, `financial_status='paid'`, `source_name='internal_subscription_comp_renewal'`, `payment_details.comp=true`. A $0 *paid* order is a clear comp marker that does **not** read as a failed payment and does **not** trip dunning.
   - Record a `type='comp'` `status='succeeded'` $0 transaction (no Braintree id) for the ledger.
   - **Advance `next_billing_date`** (same cadence math; drops spent one-time items).
   - Hand off to **Amplifier** (free fulfillment) with the Haiku packing-slip note.
   - Log a `subscription.comp_shipped` event. **Never** closes/opens a dunning cycle.

**Comp ≠ broken payment.** The comp branch is entirely separate from the decline→dunning path, so a comp sub is never marked failed or routed into dunning. Comp is set deliberately (owner/admin) — the standing roster is visible on Customers → Comp Subscriptions (Phase 2).

## Legacy Appstle path

For `is_internal=false`:

- Appstle runs its scheduler invisibly to us.
- On success, Appstle webhook posts → we update [[../tables/subscriptions]] state + create [[../tables/orders]] (since the resulting Shopify order is what we mirror).
- On failure, Appstle webhook posts → our dunning-webhook handler creates a [[../tables/dunning_cycles]] row + fires `dunning/payment-failed`.
- All our subscription mutations go through `src/lib/appstle.ts` helpers, which internally check `is_internal` and bypass for internal subs.

## Migration path (Appstle → internal)

**Live** ([[migrate-to-internal]]). Triggered when a customer captures a payment method (checkout, portal add-card, recovery link) or by the self-healing guard on portal load. Per sub in the customer's link group:

1. Resolve a **billable** member (default Braintree PM) — skip if none ("a migration must be billable").
2. Read the **live Appstle contract**; translate lines → internal catalog **UUID** references via the smart pricing logic ([[appstle-pricing]] `inferAppstleLineBase`) — reads `pricingPolicy.basePrice` when present, else reverse-engineers `currentPrice/(1−sns)`; sets `price_override_cents` only when grandfathered **and strictly below catalog MSRP** (an at-or-above-MSRP base is never stored — it would feed the −25% S&S + quantity-break math from too high a start and inflate the charge; see the base ≤ MSRP invariant in [[migrate-to-internal]] + [[migration-fix]] `price_reconcile` clamp). This is **heal-by-migration** (the internal sub is born with correct pricing; no Appstle heal first). A **"Shipping Protection"** line is NOT translated into `items[]` — it's converted to the internal flag (`shipping_protection_added=true` + `shipping_protection_amount_cents`), which the engine bills separately on top of the product subtotal, and is **excluded** from the captured `pre_migration_charge_cents` baseline (so the audit's `pricing_preserved` compares product-subtotal ≈ product-subtotal). Customer total unchanged (subtotal + flag protection). See [[../specs/migration-shipping-protection]].
3. Cancel the Appstle contract (reason **"migrated to shopcx"**).
4. Flip the existing row **in place** → `is_internal=true`, native `internal-*` contract id, status preserved (active/paused/cancelled), reassigned to the billable member.
5. **Verify** ([[migration-audit]]) — record a [[../tables/migration_audits]] row + run the 8-check checklist; the `/dashboard/migrations` monitor surfaces anything stuck, and the retry cron re-verifies pending rows.

Cancelled subs migrate too (using the local row when Appstle is unreadable). The Appstle webhook handler ignores `is_internal` subs so a stale cancel can't clobber a migrated row.

**Comp migration (no-PM path).** `migrateContractToInternalComp(workspaceId, contractId, { compNote })` ([[migrate-to-internal]]) flips **one** Appstle contract → internal **comp** sub **without** the billable-PM requirement (a comp sub never charges, so "must be billable" doesn't apply). Reuses translate-lines + cancel-contract, then sets `comp=true` + `comp_note` + every item `price_override_cents=0` (base $0), preserving items/cadence/next date and the `customer_id` (no billable reassignment). **No `migration_audit` is recorded** — the 8-check audit's `card_pinned` check expects a billable card a comp sub deliberately lacks.

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

## Failed-payment mutation block is Appstle-only

Shipped ([[../specs/portal-failed-payment-block-exempts-internal-and-offers-inline-card-update]], derived from ticket 115350d5 on sub `e1d4f32b` / `internal-d0bd95b7651b493b`). The portal's change-date + frequency handlers rejected on `last_payment_status='failed'` **without** checking `is_internal`, over-blocking internal subs whose mutation would in fact succeed (proven live: the same sub's date moved Oct 1 → Oct 6 with `{success:true}` and the flag untouched). The block only makes sense for **Appstle** contracts, where Shopify owns the charge and the card must be replaced upstream before a modification can safely land.

**Guard** ([[../libraries/portal__handlers__change-date]] + [[../libraries/portal__handlers__frequency]] via `shouldBlockForFailedPayment` in `src/lib/portal/failed-payment-guard.ts`): the predicate returns `true` **only** for `{is_internal: false, last_payment_status: 'failed'}`. Internal subs pass through regardless of the flag; Appstle subs with a healthy last payment also pass through. The single `resolveSub`-returned row carries both fields, so the handler doesn't re-query `subscriptions`. Unit-tested in `src/lib/portal/failed-payment-guard.test.ts`.

**Portal recovery UX** ([[customer-portal]] § Payment methods · Failed-payment block recovery). When the block correctly fires (Appstle sub, genuine failure), the real-portal detail screen renders an inline **"Update payment method"** primary CTA on the error overlay — no dead-end text. The customer's in-flight mutation is stashed in `sessionStorage` under the sub's **UUID** (invariant across migration; keying by `contract.id` would break because `migrateContractToInternal` rewrites `shopify_contract_id` to `internal-<hex>`). The CTA deep-links to `/payment-methods?add=1&forSub=<uuid>&retryOnSuccess=1`; the payment section vaults the card with `migrate: true` so [[migrate-to-internal]] sweeps the sub onto internal rails synchronously, then pins the new card via `setSubscriptionPaymentMethod` (its `is_internal` guard now passes) and redirects back with `?retry=1`. The subscription-detail screen consumes the marker, replays the pending change-date / frequency mutation through the top-level action overlay, and refreshes the contract — the customer's original intent completes in one flow. The Shopify-extension portal is sunset and out of scope.

## When dunning meets a charge

If a sub is in an active [[../tables/dunning_cycles]] when its `next_billing_date` rolls around:

1. The dunning cycle is the source of truth for retry timing — internal scheduler **skips** any sub with an active cycle that hasn't reached its scheduled payday-retry time.
2. When dunning succeeds, it fires `dunning/billing-success` which resets `next_billing_date` and resumes normal scheduler involvement.

This avoids double-charging during recovery.

## Overcharge detection + remediation

A renewal can charge **above** the customer's grandfathered/established rate — a silent price creep, or a dropped grandfathered base now billing at/above MSRP (the `pricingPolicy: null` landmine). [[../libraries/subscription-overcharge]] detects this read-only and emits the `{charged, expected, delta, dropped_base}` signal, surfaced into BOTH the orchestrator account context ([[../libraries/subscription-overcharge]] callers) and the [[../specs/box-escalation-triage]] solver brief. On any subscription cancel / refund / "wrong price" ticket the agent **checks for an overcharge before reaching for create_return / cancel**. When detected, the remediation playbook is: (1) `partial_refund(charged − expected)` on the overcharging order; (2) `update_line_item_price` to restore the grandfathered base going forward — Appstle heal in place (`subUpdateLineItemPrice → healOnTouch`) or `price_override_cents` for internal subs, **NEVER migrate-to-internal**; (3) a `customer_reply` (caught it, refunded the difference, fixed the sub, no cancel needed). The established baseline is clamped to the 50%-MSRP floor so remediation never contradicts the floor policy.

## Tax handling on refunds

When a Braintree refund is issued via [[../inngest/returns]] → [[return-pipeline]], the Avalara transaction must be **voided** (or partial-adjusted) — else we over-remit tax to the state.

`refundBraintreeTransaction()` in `src/lib/integrations/braintree.ts` calls Avalara's `void` endpoint with the stored `avalara_transaction_code`. Full refund → DocVoided. Partial → adjustment transaction.

## Files touched

| File | Purpose |
|---|---|
| `src/lib/internal-subscription.ts` | Internal scheduler core |
| `src/lib/inngest/internal-subscription-renewals.ts` | Hourly cron |
| `src/lib/subscription-renewal-guard.ts` | Pre-charge overcharge guard (fail-safe) |
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

**Appstle → internal migration is LIVE** (heal + smart-migration + monitor, verified 2026-06-18). Triggered on payment-method capture / portal load. Migrations are **born healed** (`inferAppstleLineBase`, [[appstle-pricing]]); every Appstle mutation heals `pricingPolicy: null` lines first via the `appstleMutate` gateway; each migration is verified by an 8-check audit ([[migration-audit]] → [[../tables/migration_audits]]), surfaced on [[../dashboard/migrations]], re-checked by [[../inngest/migration-audit-retry]] (10-min) and back-filled by [[../inngest/migration-integrity-sweep]] (daily).

**Shipping protection line→flag conversion** ([[../specs/migration-shipping-protection]]): the migration now converts the Appstle "Shipping Protection" line into the internal flag + excludes it from the audit baseline, so protection-carrying contracts pass `pricing_preserved` on the first audit. Already-stuck subs are repaired by the [[migration-fix]] `shipping_protection_convert` fix_kind (gated, owner-approved) — first applied to sub `4b831caa`.

**Base ≤ MSRP invariant** ([[migrate-to-internal]] write guard + [[migration-fix]] `price_reconcile` clamp, verified 2026-06-21): `price_override_cents` locks a grandfathered base ONLY when **strictly below** catalog MSRP (`product_variants.price_cents`); an at-or-above-MSRP base is never written, and the migration-fix agent can never reconcile a sub *upward* past list. Stranded over-MSRP overrides from the old reverse-engineering code were swept + dropped by `scripts/backfill-drop-over-msrp-overrides.ts` (first repair: Lisa Baker `fdc1d5e3` → engine re-derived **$110.34** → `pricing_preserved` cleared).

**Known gaps / not yet shipped:**
- **Phase 1b — consolidate stray direct Appstle fetches onto real wrappers.** The ~9 direct-`fetch` sites currently carry a `healOnTouch` guard (functional chokepoint); the cleaner end state is one literal path through `appstleMutate`. Deferred (touches dunning/journey-complete/action-executor); dunning's strays fold into the separate dunning rework. See [[appstle-pricing]].
- Per `feedback_no_double_billing_framing` memory: customer comms must not frame parallel-sub charges as "double billing." That rule lives in sonnet_prompts, not in this lifecycle — but flag it for anyone touching billing UX.

**Subscription overcharge remediation** ([[../specs/subscription-overcharge-remediation]], [[../libraries/subscription-overcharge]]): detection signal `{charged, expected, delta, dropped_base}` surfaced into the orchestrator + escalation-triage; remediation = partial_refund(delta) → restore grandfathered base (Appstle heal / internal `price_override_cents`, never migrate-to-internal) → customer_reply. `update_line_item_price` direct action now routes internal subs.

**Failed-payment mutation block scoped to Appstle + inline card-update recovery** ([[../specs/portal-failed-payment-block-exempts-internal-and-offers-inline-card-update]], derived from ticket 115350d5 on sub `e1d4f32b`). The change-date + frequency portal guards now key on `is_internal` — the block only fires for Appstle contracts with `last_payment_status='failed'` ([[../libraries/portal__handlers__change-date]] + [[../libraries/portal__handlers__frequency]] via `shouldBlockForFailedPayment`). When the block DOES apply, the real portal renders an inline "Update payment method" CTA that migrates the sub to internal via [[migrate-to-internal]], pins the new card, and auto-replays the previously-blocked mutation — the customer's original intent lands in one flow instead of a text dead-end. See § Failed-payment mutation block is Appstle-only above.

**Renewal charges the sub's configured (grandfathered) price** ([[../specs/subscription-renewal-honors-configured-grandfathered-price-never-bills-standard]], derived from ticket 5402b5d4). The engine honors `items[].price_cents` as an authoritative post-discount lock (Phase 1), and a pre-charge overcharge guard ([[../libraries/subscription-renewal-guard]]) holds any renewal whose computed unit exceeds the sub's configured ceiling before it reaches Braintree (Phase 2). Contract: **a renewal's per-unit is the sub's configured line price + `applied_discounts` — never the product's current standard catalog price**; a computed amount exceeding the configured total is **held** (not billed), `next_billing_date` is not advanced, and a `subscription.renewal_held_overcharge_guard` [[../tables/customer_events]] row is logged for review.

**Recent activity:**
- `2bce67a4` Returns: refund instantly on delivered using stored net_refund_cents (touches transactions)
- `49cfd939` Orchestrator: add bill_now action + auto-fallback in change_next_date

**Open questions:** None.

## Related

[[commerce-sdk]] · [[storefront-checkout]] · [[dunning]] · [[return-pipeline]] · [[chargeback-pipeline]] · [[../integrations/appstle]] · [[../integrations/braintree]] · [[../integrations/avalara]] · [[../libraries/appstle-pricing]] · [[../libraries/migration-audit]] · [[../tables/subscriptions]] · [[../tables/orders]] · [[../tables/transactions]] · [[../tables/dunning_cycles]] · [[../tables/migration_audits]] · [[../tables/order_refunds]] · [[../dashboard/migrations]] · [[../inngest/internal-subscription-renewals]] · [[../inngest/portal-auto-resume]] · [[../inngest/migration-audit-retry]] · [[../inngest/migration-integrity-sweep]] · [[../inngest/refund-settlement-reconcile]]
