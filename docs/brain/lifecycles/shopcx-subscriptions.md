# ShopCX subscriptions — the custom subscription platform (design)

**Status: DESIGN + client shipped (behind the commerce SDK); no caller wired yet.** This page is the architecture for replacing **Appstle** with our own
Shopify subscription app. Everything marked ✅ was verified against the live store on 2026-09-09;
everything else is design intent. Owner: [[../functions/retention]] · Builder: Ada
([[../functions/platform]]).

> **Scope discipline (CEO, 2026-09-09).** The goal is **removing Appstle**, NOT replacing the
> internal Braintree subscription path. The 145 `is_internal=true` subs keep their existing
> renewal engine untouched. This page is only about the 2,405 subs that bill through
> Appstle-owned Shopify contracts.

## Why this is a client swap, not a rebuild

Appstle is a wrapper around Shopify's own subscription APIs plus a scheduler and a UI. Nearly every
function in `src/lib/appstle.ts` maps 1:1 onto a Shopify mutation, so the work is: write a
`shopify-subscriptions.ts` with the same signatures, swap the callers, delete `appstle.ts`. Every
existing call site — portal handlers, playbook executor, action executor, orchestrator — keeps
working.

| `appstle.ts` | Shopify | Draft? |
|---|---|---|
| `appstleSubscriptionAction` (pause/cancel/resume) | `subscriptionContractPause` / `Cancel` / `Activate` | no |
| `appstleSkipNextOrder` / `appstleSkipUpcomingOrder` | `subscriptionBillingCycleSkip` | no |
| `appstleUnskipOrder` | `subscriptionBillingCycleUnskip` | no |
| `appstleUpdateBillingInterval` | `subscriptionDraftUpdate` | yes |
| `appstleUpdateNextBillingDate` | `subscriptionContractSetNextBillingDate` | no |
| `appstleAttemptBilling` / `orderNowByContract` | `subscriptionBillingAttemptCreate` | no |
| `appstleSwitchPaymentMethod` | `subscriptionDraftUpdate` (paymentMethodId) | yes |
| `appstleAddFreeProduct` | `subscriptionDraftLineAdd` | yes |
| `appstleSwapProduct` | `subscriptionContractProductChange` | no |
| `appstleGetUpcomingOrders` | `subscriptionBillingCycles` query | — |
| quantity change | `subscriptionDraftLineUpdate` | yes |
| discount add/update/remove | `subscriptionDraftDiscount{Add,Update,Remove}` | yes |
| free shipping | `subscriptionDraftFreeShippingDiscountAdd` | yes |

Draft mutations share one envelope: `subscriptionContractUpdate` → mutate the draft →
`subscriptionDraftCommit`. **They are NOT in the introspected `Mutation` field list** (scope-filtered)
but they execute ✅ — probe by calling, not by introspecting.

## ⭐ The division of labour

**Shopify is dumb about WHEN, and smart about everything after.** ✅

It stores `billingPolicy` (interval + count), `nextBillingDate`, the vaulted payment method, and
computes billing *cycles*. It **fires nothing**. Verified: contract `35917070509` sat at
`nextBillingDate: 2027-01-15` with `billingAttempts: []` indefinitely until we called.

| | Who |
|---|---|
| Decide it's time to charge | **us** (cron) |
| Execute the charge | Shopify |
| Compute price from the contract | Shopify |
| Compute tax | **Shopify** — no Avalara call ✅ |
| Create the order | Shopify |
| Advance `nextBillingDate` | **us** ⚠️ |
| Customer-facing "next delivery" date | **us**, from `subscriptions.next_billing_date` |

### ⚠️ Shopify does NOT advance `nextBillingDate` after a successful charge

Verified: after billing `35917070509` successfully, the contract still read `2027-01-15`. The
calendar is ours to move. A naive implementation re-charges the same contract on every tick — which
is why `idempotencyKey` (a first-class field on `SubscriptionBillingAttemptInput`, mapping straight
onto the existing `subscription_cycle_charges` `cycle_key`) is load-bearing, not belt-and-braces.

**Untested:** whether Shopify advances the date when you charge the genuinely-due cycle via
`billingCycleSelector`. The charge above was out-of-cycle. Confirm before designing around it.

## The renewal loop

```
cron → for each due contract:
        pre-charge guards (unchanged: overcharge hold, comp, dunning window,
                           cycle claim, no-payment-method, recipient-name)
     → subscriptionBillingAttemptCreate({ idempotencyKey })   # returns in ~550ms, ready=false
     → poll subscriptionBillingAttempt(id) until completedAt  # ~8s in practice ✅
     → branch inline exactly as the Braintree path does today
     → advance next_billing_date OURSELVES
```

Measured end-to-end on a live charge: mutation returned in **550ms**, resolved at **8.2s**, order
`SC138302` created, `SALE SUCCESS $77.99` (= $69.95 + $8.04 PR tax Shopify computed itself). ✅

**Poll, don't rewrite as a state machine.** The result is pollable, so the handler stays broadly
inline and every existing guard keeps firing. Webhooks are the backstop, not the primary path:

- `SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS` / `_FAILURE` / `_CHALLENGED`
- **None are registered today** ⚠️ — see the dunning warning below.
- `CHALLENGED` (3DS/SCA) is genuinely async and has no Braintree equivalent; it needs its own state.

### Why not `subscriptionBillingCycleBulkCharge`

It exists and would charge every due cycle in one call, but its filters are only
`billingCycleStatus` / `contractStatus` / `billingAttemptStatus` — **there is no way to exclude
specific contracts**. Using it would mean converting every soft guard hold into a real Shopify
pause/skip. Per-contract is right; throughput is a non-issue (bucket 20,000, restore 1,000/s ✅ —
~100 contract-creates/sec sustainable, so 2,405 is trivial).

A genuine offload worth taking: use the **`subscriptionBillingCycles` query to find what's due**
rather than deriving it from our own `next_billing_date`, handing the anchors/skips/per-cycle-edit
math to Shopify while we keep per-contract control of firing.

## ⭐ Every mutation must round-trip to Shopify

On the internal path our DB is the source of truth and we build the order. On a Shopify contract
**Shopify builds the order from the contract**, so the contract *is* the charge and the shipment.
Anything living only in our DB is cosmetic.

So each portal action is two writes — **Shopify first (authoritative), our mirror second**. If
Shopify succeeds and our write fails we are stale but correct; the reverse lies to the customer.

**Quantity change and discount re-tier must commit in ONE draft.** Going 2→3 units moves the ladder
from 8% to 12%; separate commits leave a window where the customer is on 3 units at the 2-unit rate,
and a charge landing in that window undercharges. This means `reconcileQuantityBreak` cannot be a
sweep that runs afterwards — it belongs in the same draft as the line change.

`subscriptionBillingCycleSkip` is a **real** per-cycle skip. Today "skip" is implemented by shoving
`next_billing_date` forward, which conflates it with "change my date".

## Selling plans ✅

Group `gid://shopify/SellingPlanGroup/3141009581`, merchantCode `shopcx-subscription`. Week-based on
purpose so "Monthly" is a true 4-week cycle, not a drifting calendar month.

| Name | Interval | Selling plan |
|---|---|---|
| Every 2 Weeks | WEEK × 2 | `gid://shopify/SellingPlan/4086988973` |
| Monthly | WEEK × 4 | `gid://shopify/SellingPlan/4087021741` |
| Every 2 Months | WEEK × 8 | `gid://shopify/SellingPlan/4087054509` |

No products attached and no pricing policy on the group — both deliberate, pending decisions.

## ⭐ Pricing — four independent layers

The target shape (CEO, 2026-09-09): *in a perfect world everyone's base price is MSRP $79.95.*

```
base = MSRP                     line pricingPolicy.basePrice
  → 25% S&S                     line pricingPolicy.cycleDiscounts     (derived)
  → qty break 8% / 12%          manual discount from pricing_rules     (derived)
  → grandfather                 fixedAmount { appliesOnEachItem: true } (per-line lock)
```

`SubscriptionManualDiscountFixedAmountInput.appliesOnEachItem` ✅ is what makes the grandfather
**per-unit** — "$24 off the Mixed Berry", not "$50 off the order" — scoped by `entitledLines`.

Reference contract `35916054701` shows the whole stack live: base $79.95 → 25% → $59.96 → Buy 3 at
12% → **$52.77/unit**. Note Appstle rounds the discount **per unit**, not on the line total
(3 × 52.77 = $158.31, two cents off a naive line-level calc). Reproduce that or every migrated
contract is cents adrift.

### The ladder is data, not code

`pricing_rules` "Powder Drinks: Buy More, Save More": sns 25%, free_shipping true,
`quantity_breaks` = 1→0%, 2→8%, 3→12%. `reconcileQuantityBreak(contract)` sums mix-and-match
quantity across lines sharing the rule, looks up the tier, and adds/updates/removes a single manual
discount. Base price is never touched.

**Grandfathered tier — honour, don't offer.** 27 subs carry a "Buy 4 Discount" at 16%, a tier that
no longer exists in `pricing_rules`. Those are a **locked discount**: the reconciler never touches
them — not on migration, not on a quantity change. Same rail covers any other bespoke locked rate.
New subs can never land on 16% because the ladder is the only thing that mints a discount.

### Promo / loyalty codes ride as CODES, never copied percentages

Carry the **discount code** via `discountCodes` on the contract, not a snapshot of its value, so its
lifecycle stays governed centrally by the code's own status. The contract discount exposes
`rejectionReason`, which is how Shopify signals a code it has evaluated and refused.

⚠️ **`usageCount` is per-CONTRACT and resets to zero on a new contract.** Verified: a contract
created 2026-09-08 carries `usageCount: 0` while an older one reads `9`. So carrying an exhausted
code onto a migrated contract gives it a **brand-new life**. The importer must check before copying:

```
code inactive / expired            → drop
recurringCycleLimit = null         → carry, unlimited
usageCount >= recurringCycleLimit  → drop, exhausted
usageCount <  recurringCycleLimit  → carry with (limit − usageCount) remaining
```

`recurringCycleLimit` is declared on the code itself ✅ (`ANDREZ` null = unlimited, `SPECIALVIP` 1,
`RTX25` 2, `JULY4THVIP` 1 + EXPIRED), and Shopify already honours it — every code with a limit has
stopped applying. Skipping this check would manufacture ~$2,000/cycle of discount that does not
exist today.

### Free shipping has two representations

Some contracts carry `deliveryPrice 4.95` + a 100% `SHIPPING_LINE` discount; others carry
`deliveryPrice 0.0` and no discount. The importer must handle both or it double-charges or
double-discounts shipping. Going forward: set the shipping option explicitly via
`SubscriptionDeliveryMethodShippingOptionInput` (`title`/`code`/`carrierServiceId`) with
`deliveryPrice "0.00"`.

## ⭐ Order ↔ contract linkage

Shopify puts the contract on the order's **line item**, natively ✅:

```
order.lineItems[].contract.id    = gid://shopify/SubscriptionContract/…
order.lineItems[].sellingPlan    = { name, sellingPlanId }
```

The current linker in `src/lib/shopify-webhooks.ts` does **not** use it. Its cascade is:

1. read the `appstle_subscription.details` **metafield** → match `shopify_contract_id`
2. fall back to **SKU overlap** against any active/paused sub for that customer
3. last resort: if the customer has exactly one active/paused sub, take it

⚠️ **The primary key is an Appstle metafield**, so contracts we create carry nothing and every
renewal falls through to SKU matching — which matches on *any single overlapping SKU*, in arbitrary
order, against subs that routinely share SKUs. Ground truth: test order `SC138302` (Amazing Creamer,
from our own contract) was attached to an unrelated **internal Braintree** sub containing Amazing
Coffee, and the confirmation email printed **that** sub's next-charge date — Oct 4 instead of the
contract's Jan 15.

Two fixes, independent of each other:

- **Read `lineItems[].contract.id`** as the primary. Correct for Appstle's contracts too (they are
  Shopify contracts), so it can ship before any migration.
- **Link at charge time.** The renewal worker already knows the contract and learns the order id
  from the billing attempt (`attempt.order { id name }`). Writing the link there removes the
  inference entirely; the webhook path becomes a backstop for orders we did not originate.

And: **mirror the contract into `subscriptions` in the same unit of work that creates it**, or the
first renewal has nothing to link to.

## Migration from Appstle

Per-contract, single pass, in waves — **not** a bulk export followed by a bulk write. Reading the
payment method milliseconds before binding it removes the stale-snapshot risk entirely.

```
per contract:  Appstle GET (full state incl. customerPaymentMethod.id)
            →  create OUR contract INERT
            →  cancel the Appstle contract
            →  mark ours live
```

**The three-step ordering is the safety.** Create-live-then-cancel leaves both live on a failure →
double charge. Cancel-then-create leaves the customer with nothing. The inert middle state is
recoverable in both directions.

Hard rails: a **unique constraint on `migrated_from_contract_id`** (so a re-run physically cannot
double-create — the provenance column already exists and carries 423 rows from the internal
migration), and the renewal cron gated on migration state so a half-migrated row is never billed.

Waves of ~100 with pooled errors, rate-limit aware. Pace to **Appstle** (metered per call), not
Shopify. Read `extensions.cost.throttleStatus` on every Shopify response and back off on 429 /
`Retry-After` for Appstle.

### What only Appstle knows

Our `subscriptions` mirror is complete on everything `subscriptionContractAtomicCreate` needs —
`shopify_contract_id`, `shopify_customer_id`, `next_billing_date`, interval, items all 2405/2405;
`shipping_address` 2387/2405 (Appstle's payload carries the rest). The single gap is
`payment_method_id` (**0/2405**), and **`subscriptionContracts` returns EMPTY to us** — the scope is
`read_OWN_subscription_contracts`, so we can never read Appstle's contracts. The Appstle GET is
therefore load-bearing for exactly one field, and it matters: 39% of customers have more than one
unrevoked payment method (sample n=80; ~932 of 2,405 estimated), including Shop Pay agreements.

### Pricing on import — anchor to ORDERS, not to contract metadata

Do not reverse-engineer a base from Appstle's baked number. Pull the customer's **last 3 orders**
from Shopify, compute realized per-unit from what they actually paid, and build the grandfather
discount to reproduce **that**.

```
realized_unit = (originalUnitPrice × qty − Σ discountAllocations) ÷ qty
```

⚠️ `discountedUnitPriceSet` is a trap — it reads the **list** price even when an allocation applies.
Reading it would silently reconstruct everyone at list. Exclude $0.00 gift lines.

- 3 orders agree → build the grandfather, base stays MSRP
- they disagree → **manual review, do not migrate** (a real case: one contract charged $197.81 then
  $148.36 as a discount fell off between cycles)
- realized ≥ standard → grandfather 0, standard rules apply
- product line under $25 → manual review (21 lines, all Sleep Gummies — the floor must exclude
  Shipping Protection, whose normal price is $3.95–$6.66)

## Portal + retention surface — whole as of 2026-09-11 ✅

A migrated customer must not be stranded with an uneditable subscription, and a retention flow must
not promise something that silently never lands. Every portal and save-offer path now resolves the
engine rather than assuming "not internal ⇒ Appstle":

| Surface | Where the branch lives | ShopCX behaviour |
|---|---|---|
| quantity · remove · add · swap · price-pin | `subscription-items.ts` → [[../libraries/commerce__shopcx-line-ops]] | draft edit + full structural recompute, one commit |
| coupon apply/remove · loyalty | `subscriptionApplyCoupon` / [[../libraries/coupons]] → [[../libraries/commerce__shopcx-discount-ops]] | manual discount minted from `resolveCoupon`; burns at apply |
| cancel-flow save offers · journey remedies | [[../libraries/commerce__subscription]] `applyCoupon` | same as above |
| retention gift | `subscriptionAddFreeProduct` → `shopcxAddOneTimeLine` | **cycle-scoped** edit, not a contract line |
| order now | `subscriptionOrderNow` | fires the renewal-attempt event, which claims the cycle |
| shipping address | `portal/handlers/address.ts` → `subscriptionUpdateShippingAddress` | draft `deliveryMethod` update, then the mirror |
| portal replace-variants | `portal/handlers/replace-variants.ts` | decomposed into the engine-aware item mutations; one-time adds go cycle-scoped |
| agent price restore | `action-executor.ts` `update_line_item_price` | `subUpdateLineItemPrice` → base-price pin |
| pause · cancel · resume · skip · dates | [[../libraries/commerce__subscription]] | direct Shopify mutations |

Each of the coupon surfaces previously read the workspace's Appstle key and, without one, either
refused with *"Appstle not configured"* or silently applied nothing. On a migrated contract that
turns an **accepted save offer into a cancellation**.

### ⚠️ Shopify's address object REPLACES — it does not merge

`deliveryMethod.shipping` replaces the whole shipping method, and the address inside it replaces
wholesale too: an omitted field is CLEARED. Observed live — an update that did not mention `phone`
wiped a real number off the contract, and one that omits `shippingOption` drops the customer's
"Economy" rate, leaving the renewal order with no rate to build from. `shopifyUpdateShippingAddress`
reads the current address + option and merges them UNDER the caller's values. The portal sends
`phone || ""`, so an empty phone means "none to send", never "clear it".

`MailingAddressInput` also takes `countryCode` / `provinceCode`, not the full names — passing names
silently produces an address Shopify cannot geocode.

**Still refusing for ShopCX (1 op):** `subscriptionSendPaymentUpdateEmail` — no Shopify equivalent;
needs our own Resend flow. It refuses loudly (`shopcxUnsupported`), never silently.

### Dispatch now lives in ONE place, enforced

`scripts/_check-vendor-dispatch-in-sdk.ts` fails the build on (1) a vendor module resolving the
engine — by helper name **or** by raw `is_internal` / `billing_source` column read — and (2) any
caller outside the SDK reaching a dispatching vendor function. The raw-column rule found
`orderNowByContract`, which had been dispatching inside `appstle.ts` unnoticed.

The line the guard draws is **dispatch, not engine-awareness**: a vendor may DECLINE work that is
not its own (return a no-op and route nowhere — safe for an engine nobody has written yet), but it
may not hand the call to another engine, because then "not mine ⇒ theirs" is baked in.
`healAppstleContract` is a decline: it used to guard on `isInternalSubscription`, so a ShopCX
contract fell through and burned a metered Appstle call on every portal touch, across seven
surfaces.

## Open decisions

- **~$9,700/cycle**: 974 lines are priced above the standard ladder because their subs never got a
  quantity break. Applying standard rules fixes that and costs real money.
- Whether to reconcile the **two tax engines** (Avalara on the internal path, Shopify on contracts).
- `inventoryPolicy` on the attempt: `PRODUCT_VARIANT_INVENTORY_POLICY` (refuse to charge when out of
  stock) vs `ALLOW_OVERSELLING`.
- 84 lines whose **variant no longer exists in the catalog** — these hard-fail
  `subscriptionContractAtomicCreate` and need a call before wave 1.

## ⚠️ Cutover blocker — dunning loses its trigger

Billing-failure events arrive **only** via Appstle's webhook (`/api/webhooks/appstle/[workspaceId]`,
HMAC-verified with `workspaces.appstle_webhook_secret_encrypted`). Our app has **no**
`SUBSCRIPTION_BILLING_ATTEMPTS_*` topics registered. Removing Appstle stops dunning receiving
failures **silently** — no errors, cards simply never rotate and nobody gets a payment-update email.

Register and prove those topics **before the first contract moves**. See [[dunning]].

**Done 2026-09-09** ✅ — all three are registered and verified live on the shop:
`subscription_billing_attempts/success`, `/failure`, `/challenged`. They dispatch to
`src/lib/shopify-billing-attempt-webhook.ts`, which **records into
[[../tables/shopify_billing_attempt_events]] and deliberately does NOT drive dunning yet**.

The expectation is that these webhooks are scoped to the app that CREATED the contract, so
Appstle's contracts never reach us — well supported, since `subscriptionContracts` already
returns empty to us under `read_OWN_subscription_contracts`. But if that is wrong, wiring
dunning straight through would double-trigger every Appstle failure. The observation costs
nothing and answers itself within hours given the failure volume: **any row whose
`resolved_subscription_id` is NULL is an Appstle contract reaching us**. No null rows ⇒
confirmed ⇒ wire dunning to the failure topic and retire the Appstle relay.

Registering also surfaced a long-standing bug: **`fulfillments/update` is not a valid Shopify
topic** and had never registered — the old registrar counted its 422 as success. The registrar
now verifies against `GET /webhooks.json` instead of trusting the status. No data was lost
(fulfillments arrive via `orders/updated` + EasyPost), but `handleFulfillmentUpdate` is dead
code.

## Related

[[subscription-billing]] · [[dunning]] · [[customer-portal]] · [[../integrations/appstle]] ·
[[../integrations/shopify]] · [[../libraries/pricing]] · [[../tables/subscriptions]] ·
[[../functions/retention]] · [[../functions/platform]]
- [[../libraries/commerce__shopify-subscription-client]] — the client itself (exports, gotchas, the guard carve-out)
- [[../libraries/commerce__shopcx-line-ops]] — line mutations + the structural discount recompute
- [[../libraries/commerce__shopcx-discount-ops]] — coupons on a ShopCX contract
