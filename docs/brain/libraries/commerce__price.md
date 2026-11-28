# libraries/commerce__price

The ONE money resolver — shape-agnostic core that turns a subscription row into per-line `{ base_cents, unit_cents }` + an order-level pricing summary for every display surface.

**File:** `src/lib/commerce/price.ts` · **Spec:** [[../specs/commerce-sdk-scaffold-money-resolver]] · **Depends on:** [[pricing]]

## Why this exists

Two branches, one shape:
- **internal** — priced live by the engine ([[pricing]])
- **Appstle** — uses baked line prices, then normalizes the coupon on top

The **money invariant** (`PriceInvariantError`) is enforced on every priced line: `base_cents` + `unit_cents` must be a finite integer. Gifts (unit $0) + shipping-protection lines are expected zeros and are NOT gated. This is the "$NaN / $0 / undefined cents" leak the SDK exists to prevent.

The legacy call sites still resolve via a thin shim at `src/lib/portal/helpers/enrich-pricing.ts`, which re-exports this file's `priceSubscription` while the migration to `@/lib/commerce` completes.

### Coupon display — shipping-target guard

`computeDisplayCoupon` folds `applied_discounts` into the order-level `discount_cents`. **Shipping-target discounts must NOT reduce the product subtotal.** Shopify/Appstle models "Free Shipping on Subscriptions" as a **100% `PERCENTAGE` discount with `targetType: SHIPPING_LINE`**; applying it against products zeroes the subtotal and shows a fake "shipping-only" total while the card is billed the real product price. `isShippingTargetDiscount` skips these — authoritative signal is `targetType === "SHIPPING_LINE"` (captured at [[../integrations/appstle]] webhook ingest), with a `/free\s*ship/i` title fallback for rows synced before that field existed. Regression: `price.freeship.test.ts` (`npm run test:commerce-price-freeship`). Origin: ticket `eca3f43b` (portal showed a customer −$119.92 → Total $4.95 on a $116.96 renewal; 417 live subs affected).

### Coupon display — baked-vs-on-top rule (non-internal subs)

On a **non-internal** sub the stored `items[].price_cents` is **already post-discount**: [[commerce__shopcx-line-ops]] writes `realized = base − structuralDiscountCents` over exactly `STRUCTURAL_DISCOUNT_TITLES` (`Subscribe & Save`, `Volume discount`, `Legacy rate`), and Appstle's contract-line `currentPrice` already reflects the same selling-plan Subscribe & Save. So on the non-internal branch `computeDisplayCoupon` must subtract **only discounts applied ON TOP of the line price** — order-level coupon codes, loyalty, fixed-amount credits, and contract-level automatics like Appstle's `Buy N Discount` — and must **NOT** re-subtract the baked structural rates.

- **`isBakedIntoLinePrice(discount)`** (exported) → true for a structural rate already in the line price. Classifier is **by title** (`STRUCTURAL_DISCOUNT_TITLES` + a `/subscribe & save/i` fallback for migrated rows that carry the percent in the title), **not** by `type === "AUTOMATIC_DISCOUNT"` — doing it by type would wrongly swallow the on-top `Buy 2 Discount` the freeship regression pins.
- **Spent / cycle-limited coupons are excluded** — a one-cycle `LOYALTY-15-*` already used on the prior order (`remaining_cycles <= 0`, or `usageCount >= recurringCycleLimit`) is not billed again, so it is not subtracted from the display either.
- **Duplicate `applied_discounts` entries are de-duped** by id/code/title before applying (counted once).
- The internal branch passes `bakedLinePrices: false` and is **unchanged** (it prices live; `applied_discounts` carries only the coupon).

This fixes the double-discount display bug: a ShopCX sub mirrors its structural `Subscribe & Save`/`Volume discount` into `applied_discounts` (see [[commerce__shopcx-discount-ops]] `writeMirror`) AND bakes them into `price_cents`, so the old calculator took S&S off twice — the reminder showed **$29.28** while the real charge was **~$45.17** (64 of 70 reminded subs, median gap ~$35, up to $163). The reminder, next-order journey and Portal all read this one resolver, so the fix lands on every surface at once. Regression: `price.double-discount.test.ts` (`npm run test:price-double-discount`). Audit: `scripts/_audit-shopcx-display-vs-last-order.ts` (read-only distribution of displayed total vs last paid order).

**Safety cross-check (reminder):** [[pre-renewal-reminders]] `reminderChargePreview` cross-checks the computed pre-tax amount against the sub's last paid renewal (net of tax) via `amountMatchesLastRenewal`. With unchanged line items, a gap > $2 that no coupon change explains ⇒ the amount is omitted and one `billing_alert` (severity in metadata) is raised rather than show a possibly-wrong number (CEO 2026-11-27 guardrail).

## Exports

- **`priceSubscription(workspaceId, sub)`** → `{ priced: Map<string, PricedLineLite>, pricing: ContractPricing }` — the core resolver. Returns per-line priced pairs keyed by BOTH line_id AND variant_id, plus the order-level pricing summary. Throws `PriceInvariantError` on any undefined/NaN cents on a product line. **Pass `sub.comp`** — a comp (free) sub must price fully to $0; see `resolveProtectionCents`.
- **`resolveProtectionCents(sub)`** → `number` — pure. Shipping-protection cents from the `shipping_protection_added` / `shipping_protection_amount_cents` COLUMNS: **`comp` ⇒ 0** (a comp renewal bills $0 by design, so the portal must not show a $4.95 protection line + total the customer is never charged), else the added amount (0 when not added). Regression: `price.test.ts`. Origin: CEO's owner-comp sub showed protection $4.95 + total $4.95 in the portal.
- **`protectionLineCents(items)`** → `number` — pure, exported. Shipping-Protection cents derived from a sub's contract LINE ITEMS (`Σ price_cents * quantity` over lines whose title includes 'shipping protection'). On many non-internal subs protection is a real contract line with the `shipping_protection_added` column still false, so the column path returns 0 and the fee silently drops from the total (2026-11-28: sub 00d26522 showed $52.46 but billed $57.46). The non-internal branch of `priceSubscription` sets `protection_cents = max(resolveProtectionCents(sub), protectionLineCents(items))` so protection is counted EXACTLY once (never doubled when it is both a line AND the column). The Shipping Protection line stays OUT of the product subtotal + item list (not a product) but IN the total. Regression: `price.double-discount.test.ts` ground truths 3–5.
- **`priceSubItemsForDisplay(workspaceId, sub)`** → `Array<Record<string, unknown>>` — dashboard-widget helper that fills `price_cents` + `base_price_cents` on raw `subscriptions.items` for internal subs (Appstle items pass through, they already have baked `price_cents`).
- **`enrichContractPricing(workspaceId, sub, contract)`** → `ContractPricing` — API-handler wrapper that writes base/charged onto `contract.lines` (internal subs only). Returns the order-level pricing summary.
- **`isBakedIntoLinePrice(discount)`** → `boolean` — pure, exported. True iff a discount is a structural rate already in the non-internal line price (so it must not be subtracted again). Title-based (see baked-vs-on-top rule above).
- **`spentOnTopDiscountCents(appliedDiscounts, subtotalCents)`** → `number` — pure, exported. Face value of on-top coupons that are spent/cycle-exhausted (billed last cycle, not this one). Used by the reminder cross-check to explain a legitimately-higher charge.
- **`PriceInvariantError`** — thrown when a subscription line's resolved money is not a finite integer. Message includes `subscriptionId` + `lineId`.
- **Types:** `ContractPricing`, `PricedLineLite`, plus re-exports `Cents`, `PricedLine` from [[commerce__types]].

## Callers

Called by every commerce Display op (see [[commerce__subscription]]). Legacy re-export at `src/lib/portal/helpers/enrich-pricing.ts`.

---

[[../README]] · [[../../CLAUDE]] · [[commerce__subscription]] · [[pricing]]
