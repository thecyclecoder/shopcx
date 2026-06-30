# libraries/blended-cac-ltv

The **Growth Director's single top-line** — blended new-customer CAC↔LTV ratio + payback window
(Phase 1 of [[../specs/growth-blended-cac-ltv-objective]], M2 of [[../goals/growth-director]]).
Composes the two upstream measurement spines into one number so the Director optimizes a single
blended objective instead of per-channel ROAS (the Goodhart guardrail the goal calls out).

```
cacLtvRatio = blendedLtvCents / CAC      // CAC = blendedSpendCents / blendedNewCustomers
paybackDays = blendedSpendCents × windowDays / blendedRevenueCents   // window-rate extrapolation
```

- **Numerator (LTV)** — predicted lifetime margin per new customer from
  [[storefront-ltv-proxy]] `estimateSubLTV` (the current uncalibrated proxy is acceptable; flagged
  `assumptions.ltvProxyUncalibrated=true` until [[../specs/storefront-ltv-proxy-reconciler]] Phase 3
  recalibrates). Revenue-weighted across the products that captured new-customer revenue in the window.
- **Denominator (CAC)** — `computeAcqROAS` inputs from [[acquisition-roas]]: non-renewal new-customer
  revenue + mapped Meta spend in cents, including the Amazon halo per `credit_amazon_to_meta`.
- **Margin-ROAS is deferred** — surfaced as `assumptions.marginRoasBlockedOnCogs=true` because
  [[storefront-optimizer-agent]] `computeModeledRenewalMargin` still documents
  `cogs_source_missing=true` today. **Declared, never blocked-on.**

**File:** `src/lib/blended-cac-ltv.ts` · Spec: [[../specs/growth-blended-cac-ltv-objective]] ·
Goal: [[../goals/growth-director]] · Owner: [[../functions/growth]].

## Exports

### `computeBlendedCacLtv` — function
```ts
async function computeBlendedCacLtv(params: {
  workspaceId: string;
  startDate: string;   // YYYY-MM-DD inclusive (Central-time)
  endDate: string;
  priorStartDate?: string;
  priorEndDate?: string;
  targetCacLtv?: number;        // default DEFAULT_BLENDED_CAC_LTV_TARGET (3×)
  targetPaybackDays?: number;
  groupIds?: string[];          // default: every group with an ad-account mapping
}): Promise<BlendedCacLtvResult>
```
Aggregates over every linked-product group with a Meta ad-account mapping (or the `groupIds`
subset): spend × `spend_share` from [[../tables/daily_meta_ad_spend]], non-renewal revenue from
[[shopify-internal-revenue]] + [[amazon__per-product-revenue]] (Amazon credited per the group's
mapping), non-renewal `orderCount` as the new-customer count, and revenue-weighted product
`est_sub_ltv_cents` from [[storefront-ltv-proxy]]. Returns `cacLtvRatio`, `paybackDays`,
`blendedSpendCents`, `blendedNewCustomers`, `blendedRevenueCents`, `blendedLtvCents`,
`assumptions`, and human-readable `flags`. **The `priorStartDate` / `priorEndDate` args are accepted
for the Phase-2 week-over-week delta but are not consumed here** — the caller computes prior by
re-invoking the composer with the prior window.

### `blendedCacLtvFromTotals` — function
```ts
function blendedCacLtvFromTotals(t: BlendedCacLtvTotals): BlendedCacLtvResult
```
The **pure aggregate-to-metric step**, split out so a unit test can pin the math on fixture totals
without a database. Same shape as `computeBlendedCacLtv` returns; takes pre-aggregated totals + the
window length + the per-group attribution toggles (`creditAmazonHalo`, `countAllNonRenewal`) and the
optional setpoints.

### Constants

- `DEFAULT_BLENDED_CAC_LTV_TARGET = 3` — a healthy DTC subscription business runs LTV ≥ 3× CAC; the
  goal's "CAC:LTV ratio healthy and trending right" success metric uses this baseline.

### Types

`BlendedCacLtvResult`, `BlendedCacLtvAssumptions`, `BlendedCacLtvTotals`,
`ComputeBlendedCacLtvParams` (see source).

## Callers

- [[growth-report-contract]] `buildGrowthReportContract` — top-line `blended_cac_ltv` MetricVsTarget
  row (with `blended_payback_days` secondary) **before** the per-product AcqROAS rows; the
  contract's `proxy` is `blended_cac_ltv` and `health_score` reflects blended target attainment
  (`cacLtvRatio / target` clamped to 100). Assumptions (`marginRoasBlockedOnCogs`,
  `ltvProxyUncalibrated`, `paybackUsesWindowRateExtrapolation`) surface verbatim on
  `contract.assumptions`.

## Tests

`src/lib/blended-cac-ltv.test.ts` — `npm run test:blended-cac-ltv`. Pins the math in
`blendedCacLtvFromTotals` against fixture totals (LTV / CAC, payback rounding, target defaulting,
flag surfacing, ratio rounding).

## Gotchas

- **`assumptions.ltvProxyUncalibrated=true` is always set.** The storefront LTV-proxy reconciler
  ([[../specs/storefront-ltv-proxy-reconciler]] Phase 3) hasn't recalibrated against actual 4-month
  cohort LTV yet, so the LTV numerator is a v1 proxy. Surface this on every consumer.
- **`assumptions.marginRoasBlockedOnCogs=true` is always set.** The CFO COGS/landed-cost spine isn't
  built; `computeModeledRenewalMargin` returns `cogs_source_missing=true` today, so the LTV here is
  revenue-side rather than contribution-margin LTV. Declared, **never blocked-on**.
- **Payback uses a window-rate extrapolation** — `paybackDays = spend × windowDays / revenue`,
  flagged via `assumptions.paybackUsesWindowRateExtrapolation=true`. It assumes the in-window
  new-customer revenue rate persists. Sub-cycle-aware payback comes when the LTV proxy is
  recalibrated (M3).
- **New-customer count = non-renewal `orderCount`.** On-site + Amazon non-renewal orders (when the
  Amazon halo is credited) — `orderCount` from the resolvers stands in for new-customer count under
  the same assumption acquisition-roas already uses for the revenue numerator.
- **Mixed assumptions surface in `flags`.** If some groups credit the Amazon halo and others don't
  (or some count all non-renewal, others only utm-meta), the blended assumption is `false` and a
  `flags` line says "mixed … across product lines". A consumer should not silently average across
  attribution regimes.
- **Group-LTV weighting is by revenue, not customer count.** Per-product `est_sub_ltv_cents` ×
  product revenue share → blended LTV. Customer-share weighting would require per-product
  new-customer counts that the resolvers don't surface today.

---

[[../README]] · [[../../CLAUDE]]
