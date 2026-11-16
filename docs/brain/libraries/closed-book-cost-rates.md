# libraries/closed-book-cost-rates

The single chokepoint that turns the real closed-month QuickBooks books into the **per-channel variable cost rates** the ROAS margin calculator (and, later, the CEO scoreboard) consume. Owner: [[../functions/cfo]] (Grace).

**File:** `src/lib/closed-book-cost-rates.ts`

## Why

The Analytics → ROAS margin calculator used to run on typed-in guesses (COGS 17%, Shipping 15%, Discounts 12%, Amazon fees 25%), which misstate lifetime profit per customer. Sep 2026 closed books show product COGS ≈14.6% and Amplifier freight+fulfillment ≈12% of gross product sales — the guesses were off. This library is the **one place** that derives those rates from the real books, so the calculator and the north-star scoreboard read the SAME numbers with no hand-rolled queries scattered across callers (the "raw `.from(...)` → STOP" rule — this IS the SDK).

## Exports

- `getClosedBookCostRates(workspaceId, months = 3, admin?, asOf?)` → `Promise<ClosedBookCostRates | null>` — the per-channel blended variable cost rates over the trailing `months` CLOSED months. Returns `null` when fewer than 1 trusted closed month exists.
- `interface ClosedBookCostRates` — `{ months: string[], website: { cogsPct, fulfillmentPct, txFeePct }, amazon: { cogsPct, fbaFeePct, sellerFeePct } }`. All rates are **fractions 0–1** (0.146 = 14.6%). `months` are the `period_month` strings used, oldest→newest.

## How it works

1. **Pick the trusted closed months.** Reads the last `months` rows of [[../tables/qb_pnl_snapshots]] (`period_month ≤ cutoff`, newest first, then reversed to oldest→newest). The **cutoff** is normally last calendar month, but before the 15th of the current month the previous month's books are premature (QuickBooks month-end entries don't fully land until ~the 15th — the close gotcha on [[../tables/qb_pnl_snapshots]]), so `newestTrustedMonth` steps back one more month.
2. **Sales denominators (pooled over the same span).** Sums channel gross sales from the per-day snapshots over `[start, end]`: website = [[../tables/qb_shopify_sales_snapshots]] `revenue` + [[../tables/qb_internal_sales_snapshots]] `gross_cents`/100 (both Amplifier-fulfilled); Amazon = [[../tables/qb_amazon_sales_snapshots]] `revenue`.
3. **Cost numerators (pooled over the N months).** Extracts the P&L lines from each snapshot's stored `raw` report **by name**, reusing the [[quickbooks]] matchers (`findAmountByName` for single lines/groups, `sumAmountsByName` for the summed website tx-fee lines) — **no QBO round-trip**:
   - **COGS** = `51000 Products COGS` + `53100 Inventory Shrinkage` (shrinkage only — NOT the ending-inventory true-up), then **split by each channel's share of gross product sales**.
   - **Website fulfillment** = `52200 Fulfillment - Amplifier` group total (52210/52220/52230) ÷ website sales (Amplifier ships website/internal orders only).
   - **Website tx fees** = the `Shopify` / `PayPal` / `Braintree` lines inside `61508 Platform Transaction Fees` ÷ website sales.
   - **Amazon FBA fees** = `52100 Amazon FBA Fees` ÷ Amazon sales.
   - **Amazon seller fees** = the `Amazon Seller` line inside `61508 Platform Transaction Fees` ÷ Amazon sales.
4. **Blend.** Rates are **pooled** (Σ cost ÷ Σ sales across the N months), i.e. the exposure-weighted blended rate — a mean-of-monthly-ratios would let a small month distort the average.

## Callers

- `src/app/api/workspaces/[id]/analytics/roas/route.ts` — serves the rates as `cost_rates` to the ROAS margin calculator (Phase 2). See the ROAS dashboard page.
- The CEO north-star scoreboard will read the same chokepoint (upcoming CFO work).

## Gotchas

- **Fractions, not percents.** `cogsPct = 0.146` means 14.6%; the UI multiplies.
- **Closed months only, pre-15th steps back.** Don't feed it the in-progress month; before the 15th the last calendar month's books are premature — `newestTrustedMonth` already handles both.
- **Name-matched lines** — same fragility as [[quickbooks]]: a QBO account **rename** breaks an extraction (a re-nesting survives). If a rate goes unexpectedly 0, check the account label in the stored `raw` first.
- **Discounts are deliberately NOT a line here.** ROAS revenue comes from `orders.total_cents` (daily-order-snapshot), already net of discounts, so a discounts rate would double-count.
- **The sales-snapshot sums must page.** These tables are per-variant, per-day, so a 3-month window passes PostgREST's 1,000-row default (Jul–Sep 2026 Shopify = 1,332 rows). `sumColumn` pages with `.range()`; an unpaged read truncated the website denominator and showed website COGS at 18.4% and fulfillment at 20.6% instead of 14.9% and 15.5%.
- **Pooled denominators need the sales snapshots populated.** If a channel's sales snapshots are empty for the span, its denominator is 0 and the guarded `pct` returns 0 (not a crash) — the fix is to backfill the snapshots, not to change the math.

## Related

[[quickbooks]] · [[../tables/qb_pnl_snapshots]] · [[../tables/qb_shopify_sales_snapshots]] · [[../tables/qb_amazon_sales_snapshots]] · [[../tables/qb_internal_sales_snapshots]] · [[../functions/cfo]]
