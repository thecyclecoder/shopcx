# `src/lib/commerce/shopcx-line-ops.ts`

Line mutations for **ShopCX-billed** subscriptions — quantity, remove, swap, add, price-pin, and
the one-time retention gift. Reached only through the commerce SDK ([[commerce__subscription]]) and
the `subscription-items.ts` chokepoint; never imported by a handler.

Sibling: [[commerce__shopcx-discount-ops]] (coupons). Vendor primitives:
[[commerce__shopify-subscription-client]]. Pricing model: [[../lifecycles/shopcx-subscriptions]].

## ⭐ The one rule: every mutation recomputes the WHOLE structural discount set, in the SAME draft

Nothing in Shopify re-evaluates a contract's discounts. A pinned tier does not follow a quantity
change on its own — Appstle's "Buy 2 Discount" entries *look* automatic but are stored manual
discounts frozen at contract creation, which is exactly why 386 Appstle contracts sit on the wrong
tier today. Recomputing from scratch is idempotent and cannot drift.

**Same draft, or there is a window.** If the quantity commits in one draft and the discount in
another, a charge landing between them bills the new quantity at the old tier.

## Structural vs. the customer's

| | Titles | Who sets it | Touched by a recompute? |
|---|---|---|---|
| Structural | `Subscribe & Save`, `Volume discount`, `Legacy rate` (`STRUCTURAL_DISCOUNT_TITLES`) | us | rewritten every time |
| Customer | the coupon code itself, or any `CODE_DISCOUNT` | the customer | **never** |

A customer can never apply an S&S or a quantity break, so anything carrying a structural title is
ours by construction. Conversely a `SubscriptionAppliedCodeDiscount` exposes no `title` at all, so
it cannot match a structural title even by accident. Wiping a loyalty or promo code on a quantity
change would silently take back something the customer was given.

## Three failure modes this module exists to prevent

These were all observed live on contract `35945087149`; none is catchable by tsc or a type.

### 1. Recomputing from the CONTRACT while editing the DRAFT
Mid-edit the **draft** is the truth and the contract is stale. Reading the contract sees the OLD
quantity: `1→2` commits the new quantity at the old tier (no volume discount at all), and the next
edit `2→1` commits an 8% two-unit discount onto a single unit. `rewriteStructuralDiscounts` reads
`getSubscriptionDraft`, never `getSubscriptionContract`.

### 2. Inferring the grandfathered rate at the wrong moment, or against the wrong base
The concession is a property of the rate the customer **already has**, not of the edit being made,
so `captureGrandfatherByLine` runs BEFORE the draft opens. Measured after, it would grow or vanish
with every quantity change.

It is measured against what the rules make of **the line's own base**, not catalog MSRP. A line
already pinned below MSRP (`shopcxUpdateLineItemPrice`) would otherwise look like it carried a
concession equal to the whole MSRP gap, and the rewrite would take that off a base that already
reflected it — **discounting twice**.

Only OUR allocations are subtracted (`structuralDiscountCents`). `lineDiscountedPrice` is net of
the customer's coupon too, so inferring a rate from it would re-mint a one-use $15 loyalty code as
a permanent per-unit `Legacy rate`.

### 3. A retention gift that ships forever
`subscriptionDraftLineAdd` on a **contract** draft creates a RECURRING line. Appstle expresses
one-time with its own `isOneTimeProduct` flag; Shopify's equivalent is editing a single billing
cycle. See `shopcxAddOneTimeLine` below.

## Exports

| Export | Notes |
|---|---|
| `shopcxChangeQuantity(ws, contractId, variantId, qty)` | the tier may move for EVERY line, not just this one |
| `shopcxRemoveItem(ws, contractId, variantId)` | refuses the last line — cancel the subscription instead |
| `shopcxSwapVariant(ws, contractId, oldVariantId, newVariantId, qty?)` | draft line update, **not** `subscriptionContractProductChange` |
| `shopcxAddItem(ws, contractId, variantId, qty)` | a variant already present RAISES the quantity |
| `shopcxUpdateLineItemPrice(ws, contractId, variantId, baseCents)` | pins the pre-discount BASE |
| `shopcxAddOneTimeLine(ws, contractId, variantId, qty, priceCents)` | cycle-scoped — the retention gift |

### Deliberate behaviours worth stating

- **A swap does NOT carry the grandfathered rate.** It was negotiated on a specific product, which
  is exactly why the concession is stored per-line and variant-scoped rather than on the contract.
  The new line is created at the new variant's catalog MSRP.
- **`shopcxAddItem` on a variant already present raises the quantity** instead of adding a second
  line. Two lines for one variant splits the quantity and makes every by-variant lookup ambiguous —
  45 Appstle contracts already carry that shape and it is what makes their verify step unreliable.
- **`shopcxUpdateLineItemPrice` pins the BASE, not the charged amount.** S&S and the break still
  apply on top, matching `price_override_cents` on the internal path. The concession is then
  re-derived from the new base — the old one is deliberately dropped, or it would double-count.
- **`shopcxAddOneTimeLine` refuses LOUDLY on a BILLED or skipped cycle.** Shopify accepts the edit
  and reports success, but that order has shipped — the customer never receives what a retention
  flow just promised, and the save offer is recorded as honoured. The gift does not run the
  structural recompute: it is not a rule line, must not move anyone into a quantity tier, and being
  cycle-scoped never appears among the contract's lines — which is also why it does not violate the
  **no `$0` consumable lines on a subscription** rule.

## Verified live

On `35945087149`, one contiguous run: baseline `$52.47` → coupon `$47.23` → qty 3 `$124.66`
(S&S + 12% break + code, **no** `Legacy rate` minted from the coupon) → qty 1 `$47.23` → coupon
removed `$52.47`. Exact round trip. Gift: cycle 2 `editedContract` carried the paid line **and** a
`$0.00` line; cycles 1/3/4 untouched.

## Related

[[commerce__shopcx-discount-ops]] · [[commerce__shopify-subscription-client]] ·
[[commerce__shopify-subscription-migrate]] · [[commerce__subscription]] · [[subscription-items]] ·
[[../lifecycles/shopcx-subscriptions]]
