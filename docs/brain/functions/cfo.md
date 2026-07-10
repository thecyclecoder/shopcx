# CFO (function)

The permanent owner of **the company's numbers** — revenue, margin, cash, CAC, LTV, and the unit economics the whole business is measured in. One of the org-chart functions ([[../goals/ceo-mode]]); this doc is both the **CFO director-agent's CEO-mode charter** and the **home that owns every CFO mandate + spec**.

> **Why this seat exists.** The [[../operational-rules]] § North star says the CEO owns company objectives and the directors' KPIs roll up to them. But a CEO north star you can't *measure* is just a slogan — and revenue, margin, CAC, LTV, and cash have no departmental home. Growth owns spend, Retention owns churn, CMO owns owned-channel revenue; nobody owned the **financial truth** those all reconcile against. This is that seat: the director who turns the other directors' activity into the dollars the CEO scoreboard reads.

> **Operate + author, never build (CEO directive 2026-06-29).** The CFO director OPERATES its own software (its `function_autonomy` is *operational* autonomy) and AUTHORS specs for the tools it needs. It NEVER drives a build: **Ada / Platform / DevOps is the sole builder for every spec, all departments, permanently** ([[platform]]). A CFO-owned spec's `owner` is attribution + where the finished tool's operation lives; the build is always Ada's.

## Scope + owned metrics

- **Owns:** the financial data layer that feeds the CEO north star — revenue (gross + net), gross margin + COGS, contribution margin, cash position, blended + paid CAC, LTV, LTV:CAC, payback period, refund/return leakage, tax exposure.
- **North-star metrics:** net revenue + MRR growth, gross + contribution margin %, LTV:CAC, CAC payback period. These are the numbers the [[ceo]] scoreboard is *measured in* — the CFO is the authoritative source for each.
- **Data we have:** [[../tables/orders]], [[../tables/subscriptions]], dunning ([[../lifecycles/dunning]]), Meta ad spend ([[../integrations/meta]] / [[../lifecycles/ad-render]]), refunds + returns ([[../lifecycles/return-pipeline]]), payments ([[../integrations/braintree]] / Shopify Payments), tax ([[../integrations/avalara]]). The raw material exists across the departments — the CFO's job is to reconcile it into one financial truth.

## Mandates (perpetual)

### Financial data & unit economics — the CEO north-star feed
Be the single authoritative source for every dollar figure the CEO scoreboard reads. Pull the real books (QuickBooks P&L) and compute revenue, margin, CAC, LTV, and LTV:CAC — not a spreadsheet — so the company north star is measured against reality, and reconcile what each director *spends* against what the business *earns*.
- **North star:** **Grow Profits** (primary) + **Grow Revenue** (the floor — too little revenue and G&A eats the profit). Two profit lines: **actual booked `net_income`** (steer ≤ $0 per fiscal year Jan–Dec for US-tax avoidance) and **`adjusted_net_income`** (with the intercompany management-fee addback — true economic profit to grow).
- **Metric:** every CEO north-star dollar figure traceable to a live query; zero un-sourced numbers on the scoreboard.
- **Status:** 🚧 **feed + visual LIVE.** 24 closed months of monthly P&L snapshotted into [[../tables/qb_pnl_snapshots]] via [[../libraries/quickbooks]]; a **QuickBooks connect card** (Integrations → QuickBooks) gets shopcx its own OAuth token; and Grace's **Financials** tab (`dashboard/agents/cfo?s=financials`) renders **11 small-multiple charts in 3 sections** — **Top Line Stats** (Revenue · Net Profit · NP + Addbacks) · **Drivers** (Fixed OpEx · Digital Ads · Transaction Fees · Mgmt Fees) · **Contributors** (Refunds · Chargebacks · Discounts & Coupons · Inventory Adjustments) — each own-scaled with a period-total headline, a range filter (24mo/this year/last year/quarter), and synced hover/click-pin per-month readout. Next: recurring monthly append + CEO scoreboard. Owner: cfo · Builder: Ada.
- **Fixed vs variable costs (design note).** Paid ads and platform transaction fees sit inside the P&L Expenses section but are **variable** costs (they scale with sales/ad-buy), so both are broken out onto their own charts and `fixed_opex = Total Expenses − digital-ads-OpEx-line − transaction-fees` is the honest "cost to operate." Digital ads are **bridged** across the 2025 account migration (pre-2025 they lived in COGS as per-channel accounts; 2025+ consolidated into OpEx "60510 Digital Advertising") so the series is continuous; `fixed_opex` nets out only the post-2025 OpEx line. Amazon FBA fees are variable too but live in COGS, already outside `fixed_opex`. All 11 lines extract from the stored raw report — no re-pull. Full column/matcher detail in [[../tables/qb_pnl_snapshots]] + [[../libraries/quickbooks]].
- **Investor portal.** The same 11-chart visual is exposed READ-ONLY to investors + owners at `/investors` via a magic-link gate, with a monthly (20th) email + SMS push carrying a plain-language performance story. Access = `comp_role in (investor, owner)`. See [[../lifecycles/investors-area]].
- **Related:** [[../libraries/quickbooks]] · [[../tables/qb_pnl_snapshots]] · [[../integrations/quickbooks-online]] · [[../lifecycles/investors-area]].

### Cash & margin oversight
Watch gross + contribution margin and cash position over time; surface a margin slide or a cash-runway concern to the CEO before it becomes a crisis. The financial early-warning system.
- **Metric:** time-to-surface a margin/cash anomaly; zero silent margin erosion.
- **Status:** ⏳ planned — follows the metrics feed.

## Owned / contributed goals

- Contributes to [[../goals/ceo-mode]] — the CFO director seat.
- Feeds the CEO's **Company North Star** scoreboard (the company-objectives measurement layer) with every financial metric.

## Status

Charter doc. Seat opened 2026-07-10 (CEO directive: the north star can't be measured without a CFO who owns the financial data). Owns revenue/margin/CAC/LTV/cash — the financial truth the CEO scoreboard is measured in. Director persona: 💰 **Grace**. Feed + tooling are the first specs.

---

[[../README]] · [[ceo]] · [[logistics]] · [[growth]] · [[cmo]] · [[retention]] · [[cs]] · [[platform]] · [[../goals/ceo-mode]] · [[../operational-rules]] · [[../project-management]]
