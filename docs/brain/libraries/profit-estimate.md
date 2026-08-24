# libraries/profit-estimate

The profit engine behind [[../dashboard/analytics__profit]]. Two modes, because QuickBooks only closes whole months: a **closed month** returns QuickBooks ACTUALS untouched; the **in-progress month** returns an estimate whose every cost factor is calibrated from the last closed months. Owner: [[../functions/cfo]] (Grace).

**File:** `src/lib/profit-estimate.ts` · **Test:** `src/lib/profit-estimate.test.ts` (`npm run test:profit-estimate`)

## Why it exists

The page used to compute profit client-side from six hardcoded constants — COGS 17% · shipping 15% · discounts 12% · Shopify-tx 3% · Amazon-fee 25% · G&A `$54,542`/mo — and counted **Meta ad spend only**. It predated the QuickBooks integration, so nothing ever reconciled it.

**Ground truth 2026-07.** That model reported **$46,065**. QuickBooks says [[../tables/qb_pnl_snapshots]] `adjusted_net_income` = **$65,458** — understated by $19,392. Every input was wrong and they partly cancelled: revenue overstated $26K, COGS+shipping overstated $9K, fees overstated $7K, fixed G&A understated $4K. The "fixed" G&A constant has ranged **$53K–$110K** over the trailing 15 months, and the ad line missed Google / Amazon / TikTok entirely.

Worse, it never modelled the **management fee** at all — so it had no way to express the founder's actual profit question.

## ⭐ Real profit = net profit BEFORE management fees

The management fee is an **intercompany PR→TX transfer-pricing charge**: a Puerto Rico advisory entity bills consulting to the TX Superfoods entity, legally moving pre-tax profit out. From the group's economic view it isn't a real cost. So the headline number is:

```
adjusted_net_income = net_income + management_fees
```

Both lines are first-class and move in **opposite directions on purpose** ([[../tables/qb_pnl_snapshots]] § The two profit lines): `net_income` is steered **≤ $0 per fiscal year** for US tax; `adjusted_net_income` is the number to grow. `computeProfitLines` therefore always emits both, even in an estimate, and the test pins that they differ by exactly the addback.

## The two modes

### Closed month → `getClosedMonthProfit`

Straight read of [[../tables/qb_pnl_snapshots]] for that `period_month`. **No modelling.** Returns `source: 'quickbooks'`. Null when the month isn't snapshotted (the route 404s with "run the snapshot backfill").

### In-progress month → `estimateCurrentMonthProfit`

**Never reads QBO for the current month.** Mid-month QBO is distorted by pending month-end inventory/COGS entries — the founder rule recorded on [[../tables/qb_pnl_snapshots]]: *"our P&L in QuickBooks is never accurate during the month."*

Revenue is projected **per stream**, because the streams behave differently:

| Stream | Method | Why |
|---|---|---|
| **Renewals** | `renewalRealized + forwardBook × collectionRate` | Renewals are **scheduled**, not paced — every open subscription already has a dated row on [[../tables/billing_forecasts]]. Pacing a daily average would ignore the actual billing calendar. |
| **New checkouts** | run-rate over complete days | Genuinely demand-driven; a daily rate is the honest estimator. |
| **Amazon** | run-rate over complete days | Same. |

Cost factors come from `deriveCalibration` over the last [[#CALIBRATION_MONTHS]] closed months (default 3).

## Calibration factors — each replaces a hardcoded constant

| Factor | Definition | Replaces | Observed Apr–Jul 2026 |
|---|---|---|---|
| `incomeRatio` | QBO `total_income` ÷ our internal gross | the 12% discount guess | 90.5 – 92.9% |
| `cogsRatio` | QBO `total_cogs` ÷ `total_income` | COGS 17% + shipping 15% | 27.4 – 36.0% |
| `txnFeeRatio` | QBO `transaction_fees` ÷ `total_income` | Shopify 3% + Amazon 25% | 5.8 – 6.3% |
| `adSpendRatio` | QBO `digital_advertising` ÷ our Meta spend | Meta-only ad spend | 0.94 – 1.16× |
| `fixedOpexCents` | trailing mean of QBO `fixed_opex` | G&A `$54,542` fixed | $53K – $60K |
| `managementFeesCents` | trailing mean of QBO `management_fees` | *(not modelled at all)* | $30K – $60K |
| `otherNetCents` | mean of (`adjusted_net_income` − `net_operating_income`) | — | −$1.4K – +$7.6K |
| `renewalCollectionRate` | realized ÷ expected on the renewal book | — | 64 – 82%, **declining** |

**`incomeRatio` is the one that quietly fixes the most.** Refunds, discounts and chargebacks are **contra-revenue accounts** in QBO (`48300` / `48200` / `48100`), so they're already netted out of `total_income`. Calibrating our gross against QBO income absorbs all three in one measured factor instead of a guessed discount percentage.

## Exports

### Pure (no DB, no clock — unit-pinned)

- `computeProfitLines(internalGrossCents, metaSpendCents, cal): ProfitLines` — the full P&L. Emits both profit lines.
- `projectRenewalRevenue(realizedCents, forwardBookCents, collectionRate): number`
- `projectFromRunRate(toDateCents, completeDays, totalDays): number` — **`completeDays` excludes today**; a partial day would drag the daily rate down and understate the month.
- `deriveCalibration(months: CalibrationInput[], renewalCollectionRate): ProfitCalibration` — **averages the per-month ratios, not the ratio of summed totals**, so one outsized month can't dominate. Pinned by test.
- `centralToday` / `monthStart` / `monthEnd` / `daysInMonth` / `previousDay` / `lastClosedMonths` — Central-time date helpers matching the snapshot crons.

### DB-backed

- `getClosedMonthProfit(admin, workspaceId, periodMonth): Promise<ProfitResult | null>`
- `estimateCurrentMonthProfit(admin, workspaceId, today): Promise<ProfitResult>`
- `readRenewalCollectionRate(admin, workspaceId, from, to): Promise<number | null>`

### Constants

- `CALIBRATION_MONTHS = 3`
- `FALLBACK_CALIBRATION` — used **only** when no closed QBO month exists (fresh workspace); the result carries a `flags` entry saying so.

## Callers

- `src/app/api/workspaces/[id]/analytics/profit/route.ts` — `?period=this_month|last_month|YYYY-MM`. Also returns `available_months` (months with a snapshot) so the page's picker only offers real data.

## Callees

- [[../tables/qb_pnl_snapshots]] — the actuals + every calibration factor.
- [[../tables/billing_forecasts]] — the renewal book (forward) + collection-rate history.
- [[../tables/daily_order_snapshots]] — `recurring_revenue_cents` (renewals realized) + `new_subscription_revenue_cents` / `one_time_revenue_cents` (new checkouts).
- [[../tables/daily_amazon_order_snapshots]] — Amazon gross.
- [[../tables/daily_meta_ad_spend]] — Meta spend, scaled by `adSpendRatio` to all channels.

## Gotchas

- **`dunning` and `paused` rows are excluded from the expected renewal book.** A `dunning` row is a RETRY of an already-counted renewal — counting it double-counts the same subscription many times. Ignoring this inflates July's expected renewal revenue from **$275K to $662K** (2.7× total company income). Dunning **recoveries** still count in the realized numerator — that revenue is real, just late. `isRenewalBookRow` is the single predicate; [[../dashboard/analytics__mrr]]'s route splits the same way.
- **The renewal collection rate is declining** — 81.9% (May) → 69.9% (Jun) → 64.1% (Jul). The 3-month mean (~72%) therefore runs slightly optimistic against the latest month. Sensitivity is small (~$3K on a full month) but the trend is worth watching; if it keeps falling, weight recent months.
- **Every daily-table read pages past the 1000-row cap.** A single ranged `select` silently truncates — the same bug the `onsite_nonrenewal_revenue` RPC was created to fix ([[shopify-internal-revenue]]). `sumDaily` and `readForecasts` both loop on `.range()`.
- **`managementFeesCents` is a policy number, not a rate.** It's whatever the PR entity billed, so a trailing mean lags a step change (Apr $30K → Jul $60K). It only moves the *booked* line — real profit is unaffected by construction.
- **Never call `estimateCurrentMonthProfit` for a closed month.** The route routes on `periodMonth === monthStart(today)`; the estimator would happily model a month that has exact actuals sitting in QBO.

## Related

[[../tables/qb_pnl_snapshots]] · [[quickbooks]] · [[../dashboard/analytics__profit]] · [[../dashboard/analytics__mrr]] · [[billing-forecast]] · [[../functions/cfo]]

---

[[../README]] · [[../../CLAUDE]]
