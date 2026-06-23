# libraries/acquisition-roas

The **core AcqROAS metric** — the Growth director's measurement spine
([[../specs/growth-acquisition-roas-spine]] Phase 3). Composes the two non-renewal revenue resolvers
(on-site + Amazon) over a linked-product group's spend on its mapped Meta ad account(s):

```
AcqROAS(group, window) = Σ non-renewal sales {Shopify+internal, Amazon}  ÷  Σ mapped Meta spend
```

This is the **proxy/tool** the Growth agent reasons on — not the objective. The agent owns profitable
new-customer acquisition and supervises this metric ([[../../CLAUDE]] § North star). Phase 4 (the
CEO-mode report contract) consumes `computeAcqROAS`; this module stops at the metric.

**File:** `src/lib/acquisition-roas.ts`

## Exports

### `getProductAdAccountMapping` — function
```ts
async function getProductAdAccountMapping(params: { workspaceId; groupId }): Promise<ProductAdAccountMapping[]>
```
Loads [[../tables/product_ad_account_mappings]] rows for a group, joined to the ad-account identity
(`meta_account_id`, `meta_account_name`). One entry per mapped account.

### `computeAcqROAS` — function
```ts
async function computeAcqROAS(params: {
  workspaceId: string;
  groupId: string;
  startDate: string;  // YYYY-MM-DD, inclusive (Central-time)
  endDate: string;
}): Promise<AcqRoasResult>
```
- **Numerator** = `getShopifyInternalNonRenewalRevenue` ([[shopify-internal-revenue]]) +
  (when `credit_amazon_to_meta`) `getAmazonNonRenewalRevenue` ([[amazon__per-product-revenue]]), over
  the group's `product_link_members` product_ids. `count_all_non_renewal=false` flips the on-site
  resolver to `metaOnlyUtm`.
- **Denominator** = Σ over mapped accounts of `daily_meta_ad_spend.spend_cents` in the window ×
  each account's `spend_share`.
- Surfaces `channelSplit` (onsite / amazon / spend), `haloRatio` (amazon ÷ onsite), the active
  `assumptions`, per-account `accounts[]`, and human-readable `flags` (shared-account floor, no
  mapping, zero spend). `acqRoas` is null when there's no mapped spend.

### Types
`ProductAdAccountMapping`, `AcqRoasAccount`, `AcqRoasResult` (see source).

## Callers

- (Phase 4 consumer) the CEO-mode Growth **report contract** — wires `computeAcqROAS` per product line.

## Gotchas

- **Shared-account floor.** When a mapped account `is_shared_account` at `spend_share=1.0`
  (coffee's account also serves creamer), the denominator carries another line's spend, so AcqROAS is a
  **conservative floor** — flagged in `flags` and `assumptions.sharedAccountFloor`. The spec's baseline
  AcqROAS(coffee, Jun 7–20) = **1.69** is exactly this floor.
- **Internal joins use the UUID** `meta_ad_account_id`, never Meta's `meta_account_id` ('d6d619a5').
- **Assumptions are group-level**, ANDed across the group's mapping rows — keep rows consistent.
- The mapping must exist first (seed via `scripts/seed-coffee-ad-account-mapping.ts`); with no mapping,
  `acqRoas` is null and `flags` says so.

---

[[../README]] · [[../../CLAUDE]]
