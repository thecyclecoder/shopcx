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
| `raw` | `jsonb` | NOT NULL · default `{}` · the FULL single-month ProfitAndLoss report (account-level drill-down preserved) |
| `source` | `text` | NOT NULL · default `quickbooks` |
| `pulled_at` | `timestamptz` | NOT NULL · default `now()` · when the snapshot was pulled from QBO |
| `created_at` / `updated_at` | `timestamptz` | default `now()` · `updated_at` set explicitly on upsert |

The nine typed rollups come from the report's top-level section `Summary` rows, keyed by each section's `group` (`Income`/`COGS`/`GrossProfit`/`Expenses`/`NetOperatingIncome`/`OtherIncome`/`OtherExpenses`/`NetOtherIncome`/`NetIncome`) — see [[../libraries/quickbooks]] `parsePnlRollups`.

## The two profit lines (why both matter)

The CEO north star is **Grow Profits (primary) + Grow Revenue (the floor — too little revenue and G&A eats the profit)**. But "profit" is two numbers here, and both are first-class:

- **`net_income` — actual booked net profit.** The GAAP number as QuickBooks reports it. The company's tax strategy is to keep the **TX Superfoods entity at or below $0 for each fiscal year (Jan–Dec)** to avoid US-based taxation. So this number is watched against a **≤ $0 annual ceiling**, summed over the calendar year (`sum(net_income) where period_month in [FY-01, FY-12]`).
- **`adjusted_net_income` — net profit with addbacks.** `net_income + management_fees`. The **management fee is an intercompany transfer-pricing charge**: a second entity in Puerto Rico bills consulting to the TX Superfoods entity, legally moving pre-tax profit out. From the *group's* economic view that fee isn't a real cost, so adding it back reveals **true economic profit** — the number to actually grow. (Some months carry no management fee at all → `management_fees` is `null` and the addback equals `net_income`.)

So the scoreboard shows **both**: booked net profit (steer ≤ $0/fiscal-year) and profit-with-addbacks (grow it). They move in opposite directions on purpose — the transfer-pricing fee is the lever between them.

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

## Related

[[quickbooks_connections]] · [[workspaces]] · [[../libraries/quickbooks]] · [[../integrations/quickbooks-online]] · [[../functions/cfo]] · [[../functions/logistics]] · [[../project-management]]
