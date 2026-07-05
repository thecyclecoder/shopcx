# libraries/commerce__price

The ONE money resolver — shape-agnostic core that turns a subscription row into per-line `{ base_cents, unit_cents }` + an order-level pricing summary for every display surface.

**File:** `src/lib/commerce/price.ts` · **Spec:** [[../specs/commerce-sdk-scaffold-money-resolver]] · **Depends on:** [[pricing]]

## Why this exists

Two branches, one shape:
- **internal** — priced live by the engine ([[pricing]])
- **Appstle** — uses baked line prices, then normalizes the coupon on top

The **money invariant** (`PriceInvariantError`) is enforced on every priced line: `base_cents` + `unit_cents` must be a finite integer. Gifts (unit $0) + shipping-protection lines are expected zeros and are NOT gated. This is the "$NaN / $0 / undefined cents" leak the SDK exists to prevent.

The legacy call sites still resolve via a thin shim at `src/lib/portal/helpers/enrich-pricing.ts`, which re-exports this file's `priceSubscription` while the migration to `@/lib/commerce` completes.

## Exports

- **`priceSubscription(workspaceId, sub)`** → `{ priced: Map<string, PricedLineLite>, pricing: ContractPricing }` — the core resolver. Returns per-line priced pairs keyed by BOTH line_id AND variant_id, plus the order-level pricing summary. Throws `PriceInvariantError` on any undefined/NaN cents on a product line.
- **`priceSubItemsForDisplay(workspaceId, sub)`** → `Array<Record<string, unknown>>` — dashboard-widget helper that fills `price_cents` + `base_price_cents` on raw `subscriptions.items` for internal subs (Appstle items pass through, they already have baked `price_cents`).
- **`enrichContractPricing(workspaceId, sub, contract)`** → `ContractPricing` — API-handler wrapper that writes base/charged onto `contract.lines` (internal subs only). Returns the order-level pricing summary.
- **`PriceInvariantError`** — thrown when a subscription line's resolved money is not a finite integer. Message includes `subscriptionId` + `lineId`.
- **Types:** `ContractPricing`, `PricedLineLite`, plus re-exports `Cents`, `PricedLine` from [[commerce__types]].

## Callers

Called by every commerce Display op (see [[commerce__subscription]]). Legacy re-export at `src/lib/portal/helpers/enrich-pricing.ts`.

---

[[../README]] · [[../../CLAUDE]] · [[commerce__subscription]] · [[pricing]]
