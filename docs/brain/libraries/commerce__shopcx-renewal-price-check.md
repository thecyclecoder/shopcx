# `src/lib/commerce/shopcx-renewal-price-check.ts`

Log-only tripwire in front of every ShopCX renewal charge. It compares what the pricing rules say a
contract should cost with what Shopify is about to charge, and files a card when they differ. It
**never blocks, delays or changes a charge** (CEO 2026-10-10, "log only").

## Why log-only

On a ShopCX contract, Shopify computes the price from the contract itself; we never pass one. So
correctness lives in the code that writes the contract: ingest normalization
([[commerce__shopcx-line-ops]] `shopcxNormalizeNewContract`), migration
([[commerce__shopify-subscription-migrate]]) and the line-ops structural recompute. This check is
the safety net behind those writes. A mismatch means the contract needs fixing for the *next*
renewal, not that this one should stop.

## Exports

| Export | What |
|---|---|
| `checkShopcxRenewalPrice(ws, contractId)` | read-only → `match` · `overcharge` · `undercharge` (with per-line detail) · `unchecked` (reason). Never throws. |
| `surfaceRenewalPriceMismatch(admin, {...})` | one `dashboard_notifications` card (`type='billing_alert'`, `metadata.kind='shopcx_renewal_price_mismatch'`), deduped on `metadata->>dedupe_key = shopcx-renewal-price:<sub>:<cycle>`. Never throws. |
| `isMaterialGap(expected, actual)` | pure: gap > max($1, 2%) — the same bar [[subscription-overcharge]] uses |

## The math

- **expected** = base → S&S → quantity tier via `shopifyLineMath` (Shopify's sequential, truncating
  allocation), minus the line's `Legacy rate` (`legacyRateCents`).
- **actual** = `currentPrice × qty − structuralDiscountCents − automaticDiscountCents` (our titles, plus any checkout `AUTOMATIC_DISCOUNT` copy still on the contract, so a leftover S&S / Buy 2-3 copy stacking on ours reads as an undercharge). Customer codes are excluded.
- **Customer coupons are excluded from both sides.** They are something the customer was given,
  not drift.
- **Base:** MSRP, unless the line sits below MSRP *and* already carries our structural discounts,
  which makes it a deliberate pin (`shopcxUpdateLineItemPrice`). Below MSRP with no allocation is
  the plan-baked checkout shape. That is measured against MSRP, so a missing quantity tier shows up.
- Protection and non-rule lines are skipped; a contract with no rule lines is `unchecked`.

## Caller

[[../inngest/shopify-subscription-renewals]] step `price-check-log`, after the cycle claim and
before `attempt-billing`. Nothing reads the step's result.

## Ground truth (dry run 2026-10-10, 172 active ShopCX subs)

168 matched, 3 had no rule lines, and 1 overcharge: test contract `35917070509` (Dylan's own),
Amazing Creamer at $69.95 with no S&S, against the $52.47 the rules give.

## Related

[[commerce__shopcx-line-ops]] · [[commerce__shopify-subscription-client]] ·
[[../lifecycles/shopcx-subscriptions]] · [[../tables/dashboard_notifications]]
