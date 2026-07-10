# qb_pnl_snapshots

Per-workspace, per-**closed-month** QuickBooks ProfitAndLoss snapshot — the financial substrate for the CEO north star (**Grow Profits** = `net_income`, **Grow Revenue** = `total_income`). Owner: [[../functions/cfo]] (Grace). Written by [[../libraries/quickbooks]].

**Why closed months only.** Mid-month QBO P&L is distorted by pending month-end entries (inventory/COGS adjustments), so only *fully-elapsed* months are snapshotted — the current in-progress month is never stored. This is the founder rule: "our P&L in QuickBooks is never accurate during the month… we only care about previous months."

**Primary key:** `id` · **Unique:** `(workspace_id, period_month)` — one snapshot per (workspace, month), upserted.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `period_month` | `date` | NOT NULL · **first day of the closed month** (e.g. `2026-06-01`) |
| `currency` | `text` | NOT NULL · default `USD` · from the report `Header.Currency` |
| `accounting_method` | `text` | NOT NULL · default `Accrual` |
| `realm_id` | `text?` | QBO Company ID provenance (Superfoods = `123146094168669`) |
| `total_income` | `numeric?` | **Revenue** — the `Income` section total (north-star line) |
| `total_cogs` | `numeric?` | `COGS` section total |
| `gross_profit` | `numeric?` | `GrossProfit` section total |
| `total_expenses` | `numeric?` | `Expenses` section total (operating / G&A) |
| `net_operating_income` | `numeric?` | `NetOperatingIncome` section total |
| `total_other_income` | `numeric?` | `OtherIncome` section total |
| `total_other_expenses` | `numeric?` | `OtherExpenses` section total |
| `net_other_income` | `numeric?` | `NetOtherIncome` section total |
| `net_income` | `numeric?` | **Actual booked net profit** — the `NetIncome` section total. The number the fiscal-year ≤$0 US-tax target watches (see below) |
| `management_fees` | `numeric?` | The "82000 Management Fees" line (positive expense). Intercompany PR→TX transfer-pricing charge — extracted from the `OtherExpenses` subtree by [[../libraries/quickbooks]] `findLineAmount` |
| `adjusted_net_income` | `numeric?` | **Net profit with addbacks** = `net_income + management_fees` — the true economic profit (primary "Grow Profits" north-star line) |
| `digital_advertising` | `numeric?` | **Variable** ad spend (FB / Google / Amazon / TikTok). **Bridged**: 2025+ reads the OpEx line "60510 Digital Advertising"; pre-2025 sums the COGS ad accounts ("Ads - Facebook/Amazon/Google/TikTok") so the series is continuous across the account migration. Excludes AWIN (affiliate). See [[../libraries/quickbooks]] `sumAmountsByName` + `AD_SPEND_MATCHER` |
| `transaction_fees` | `numeric?` | **Variable** payment/marketplace fees — the "61508 Platform Transaction Fees" group total (Amazon Seller / Shopify / PayPal / Braintree / Walmart). Sits inside OpEx but is variable, so it's broken out |
| `fixed_opex` | `numeric?` | **Derived** = `total_expenses − (OpEx digital-ads line) − transaction_fees` — the true *fixed* cost to operate, with the two variable OpEx lines removed. Uses only the post-2025 OpEx ad line (`OPEX_AD_LINE_MATCHER`), never the bridged COGS ad accounts (those never lived in `total_expenses`) |
| `refunds` | `numeric?` | Contra-revenue "48300 Refunds" (stored as positive magnitude) |
| `chargebacks` | `numeric?` | Contra-revenue "48100 Chargebacks" (stored as positive magnitude) |
| `discounts_coupons` | `numeric?` | Contra-revenue "48200 Discounts & Coupons" (stored as positive magnitude) |
| `inventory_adjustments` | `numeric?` | COGS "53100 Inventory Shrinkage" + "53000 Ending Inventory Adjustment", summed (signed — a true-up can swing either way) |
| `raw` | `jsonb` | NOT NULL · default `{}` · the FULL single-month ProfitAndLoss report (account-level drill-down preserved) |
| `source` | `text` | NOT NULL · default `quickbooks` |
| `pulled_at` | `timestamptz` | NOT NULL · default `now()` · when the snapshot was pulled from QBO |
| `created_at` / `updated_at` | `timestamptz` | default `now()` · `updated_at` set explicitly on upsert |

The nine top-level rollups come from the report's section `Summary` rows, keyed by each section's `group` (`Income`/`COGS`/`GrossProfit`/`Expenses`/`NetOperatingIncome`/`OtherIncome`/`OtherExpenses`/`NetOtherIncome`/`NetIncome`); the management-fee addback and the seven variable-cost / contributor breakout columns are name-matched against individual account labels — all in [[../libraries/quickbooks]] `parsePnlRollups`.

## The two profit lines (why both matter)

The CEO north star is **Grow Profits (primary) + Grow Revenue (the floor — too little revenue and G&A eats the profit)**. But "profit" is two numbers here, and both are first-class:

- **`net_income` — actual booked net profit.** The GAAP number as QuickBooks reports it. The company's tax strategy is to keep the **TX Superfoods entity at or below $0 for each fiscal year (Jan–Dec)** to avoid US-based taxation. So this number is watched against a **≤ $0 annual ceiling**, summed over the calendar year (`sum(net_income) where period_month in [FY-01, FY-12]`).
- **`adjusted_net_income` — net profit with addbacks.** `net_income + management_fees`. The **management fee is an intercompany transfer-pricing charge**: a second entity in Puerto Rico bills consulting to the TX Superfoods entity, legally moving pre-tax profit out. From the *group's* economic view that fee isn't a real cost, so adding it back reveals **true economic profit** — the number to actually grow. (Some months carry no management fee at all → `management_fees` is `null` and the addback equals `net_income`.)

So the scoreboard shows **both**: booked net profit (steer ≤ $0/fiscal-year) and profit-with-addbacks (grow it). They move in opposite directions on purpose — the transfer-pricing fee is the lever between them.

## Fixed vs variable, and the profit-bite lines

Beyond the two profit lines, the snapshot breaks the P&L into what the CFO visual charts as **Drivers** (big spend levers) and **Contributors** (what bites at profit):

- **Fixed OpEx vs the variable OpEx lines.** QBO files Digital Advertising and Platform Transaction Fees *inside* OpEx (`total_expenses`), but both are **variable** — they scale with sales/ad-buy, not with the cost of keeping the lights on. So they're extracted (`digital_advertising`, `transaction_fees`) and `fixed_opex` is what remains after removing them. That leaves `fixed_opex` as the honest "cost to operate" line to watch independently of ad-scale. (Amazon FBA Fees "52100" is also variable but lives in **COGS**, not OpEx — correctly out of `fixed_opex` already, so it isn't subtracted.)
- **The ad-account bridge.** Before 2025, ad spend was booked in **COGS** as per-channel accounts (`Ads - Facebook/Amazon/Google/TikTok`); from 2025 it consolidated into a single **OpEx** line "60510 Digital Advertising". `digital_advertising` bridges both eras with `sumAmountsByName` so the series is continuous; `fixed_opex` deliberately does **not** bridge (it only nets out the post-2025 OpEx ad line, since pre-2025 ads were never in `total_expenses`).
- **Contributors** (`refunds`, `chargebacks`, `discounts_coupons`, `inventory_adjustments`) are contra-revenue / shrinkage lines that quietly erode profit. Refunds/chargebacks/discounts are stored as **positive magnitudes** (the chart reads them as "how much bit"); inventory adjustments stay **signed** (a true-up swings either way).

## Who writes / reads

- **Writer:** [[../libraries/quickbooks]] `snapshotPnlMonth` / `backfillPnlSnapshots` via `createAdminClient()` (service role). Seeded by `scripts/_backfill-pnl-snapshots.ts` (24 closed months). The recurring monthly append (snapshot the newest closed month) is upcoming CFO work.
- **Reader:** the CFO Financials surface + the CEO north-star scoreboard (upcoming). RLS: workspace-member `SELECT`, service-role full.

## Gotchas

- **Closed months only** — never snapshot the in-progress month (distorted by month-end entries). `lastClosedMonths(n)` starts from the month *before* today.
- **Two profit lines, not one.** `net_income` = actual booked profit (watch it ≤ $0 per **fiscal year Jan–Dec** for US-tax avoidance); `adjusted_net_income` = with the management-fee addback (the true economic profit to grow). Don't conflate them.
- **The management-fee addback is name-matched** (`/management fee/i`) against the account label ("82000 Management Fees", currently id 338), searched recursively through the report — so a re-nesting or an id change won't break it, but a *rename* of the account would. If `management_fees` goes unexpectedly `null`, check the account label first.
- **`net_operating_income`** excludes the "other" section (where the management fee sits, under `OtherExpenses`); `net_income` is the true bottom line.
- **Backfill idempotency** is the `(workspace_id, period_month)` unique + upsert — re-running the backfill refreshes each month in place.
- **A section with no activity is simply absent** from the report → its rollup stays `null`, not `0`.
- **The variable-cost / contributor lines are all name-matched** (see [[../libraries/quickbooks]] matchers), same fragility as the management-fee addback: a re-nesting survives, an account **rename** breaks the extraction. If a series flatlines to `null`, check the QBO account label first.
- **`digital_advertising` is bridged, `fixed_opex` is not.** Don't "fix" `fixed_opex` to also subtract the bridged pre-2025 ad number — those accounts lived in COGS and were never in `total_expenses`, so subtracting them would double-count. Pre-2025 `fixed_opex` correctly nets out only the (absent) OpEx ad line.
- **Backfill the 7 breakout columns from `raw`, not a re-pull.** `scripts/_backfill-variable-costs-from-raw.ts` re-runs `parsePnlRollups` over the stored `raw` and updates only the breakout columns — no QBO round-trip, safe to re-run.

## Related

[[quickbooks_connections]] · [[workspaces]] · [[../libraries/quickbooks]] · [[../integrations/quickbooks-online]] · [[../functions/cfo]] · [[../functions/logistics]] · [[../project-management]]
