# lifecycles/profit-drivers

**What actually drives profit at Superfoods — measured, not assumed.** Owner: [[../cfo]] (Grace).

This is a **living investigation page**. It exists because profit, not revenue, is the CEO north star ([[../cfo]] § Mandates), and because almost every intuition about what moves it turned out to be either wrong or backwards when checked against 25 months of QuickBooks P&L and 12 monthly customer cohorts.

Every number here is **measured** unless explicitly labelled otherwise. Where an earlier conclusion was wrong it is kept and struck through rather than deleted — the point is to stop future sessions re-deriving a disproven answer. Add to the [findings log](#findings-log) as the investigation continues; don't silently rewrite history.

**Re-run everything:** `npx tsx scripts/_profit-drivers.ts` (read-only; QuickBooks snapshots + cohorts + regimes).

---

## ⭐ The model

```
Real profit = Income − COGS − Digital Ads − Transaction Fees − Fixed OpEx
            (+ small other income/expense)
```

Ranked by what actually moved profit over 25 closed months:

| # | Driver | Status | Evidence |
|---|---|---|---|
| 1 | **Ad spend LEVEL** (not efficiency) | The dominant lever | `r = −0.63` vs margin; two-regime split below |
| 2 | **LTV per acquired customer** | Fell ~20%, now recovering | first-order AOV $124 → $92 → $116 |
| 3 | **COGS ratio** | At series best | 27.4% (July) vs 27–47% range |
| 4 | **Fixed OpEx** | Fixed *now*, was the biggest historical win | $145K → $59K per half-year |
| — | Revenue volume | **NOT a driver** | `r = −0.05` |
| — | Churn *rate* | **NOT movable** — structural | 12 cohorts, ±13–20% spread |

### The two regimes — the single most important table here

Splitting all 25 closed months on ad load:

| Regime | Months | Avg income | Avg ads | **Avg real profit** | Margin |
|---|---|---|---|---|---|
| Ads **>25%** of income | 18 | $551K | $210K | **$35K** | **6.3%** |
| Ads **≤25%** of income | 6 | $331K | $54K | **$72K** | **21.9%** |

**40% less revenue, 2.1× the profit, 3.5× the margin.** This is the finding everything else has to be reconciled against.

> ⚠️ **Excludes 2024-12** (inventory write-off, COGS 143% of income, −$561K). Including it the high-ad-load regime reads $3K / 0.6% margin — a much more dramatic number that is an artifact of one write-off month, not of ad load. **The first draft of this page made exactly that error**; the reproducible script excludes it by default.

---

## What "profit" means here

Two first-class lines, moving in opposite directions **on purpose** ([[../../tables/qb_pnl_snapshots]] § The two profit lines):

- **`net_income`** — booked. Steered **≤ $0 per fiscal year** for US tax.
- **`adjusted_net_income` = `net_income` + `management_fees`** — the intercompany PR→TX transfer-pricing fee added back. **This is "real profit" and the number to grow.**

July 2026: `$5,458` booked + `$60,000` fees = **`$65,458` real profit** on `$248,420` income = **26.3% margin**.

Surfaced by [[../../libraries/profit-estimate]] → [[../../dashboard/analytics__profit]].

---

## Driver 1 — ad spend level

Correlation with real profit across 24 months (excluding the 2024-12 inventory write-off, which has COGS at 143% of income and swamps everything):

| Driver | r |
|---|---|
| **Ads as % of income** | **−0.63** |
| Gross profit $ | −0.37 |
| Digital ads $ | −0.26 |
| Gross margin % | −0.17 |
| **Income** | **−0.05** |
| Fixed OpEx $ | −0.02 |

### The marginal ad dollar is priced

2025-11 (worst month) → 2026-07 (best recent):

- Gave up **$117K of gross profit**
- To save **$157K of ad spend**
- ⇒ **0.74 gross profit per $1 of ad spend at the margin**

Below 1.00 means that spend was destroying value. Corroborated independently by a weekday-controlled pre/post on daily data (n=30 weekdays): scaling from ~$600/day to ~$1,900/day bought new customers at an **incremental CAC of $339 (on-site) / $276 (incl. Amazon)**, `r = 0.54`. Against a policy crown line of $150 and a hold band of $220.

### Why this keeps happening

The autonomous media buyer optimizes on **Meta-reported CPA** and cannot see LTV, Amazon, or blended CAC. A cheaper, smaller, more-discounted offer looks *better* to it — more conversions per dollar — while producing a customer worth ~20% less. See [Measurement you cannot trust](#measurement-you-cannot-trust) and [[../../libraries/media-buyer-agent]].

---

## Driver 2 — revenue mix (a consequence, not a dial)

`corr(renewal share of revenue, profit margin) = 0.92` (n=7 months) — the tightest relationship measured. Contribution per revenue dollar, July 2026:

```
RENEWAL       $1.00 − COGS 27.4% − txn 6.3%              = $0.66
NEW CHECKOUT  $1.00 − COGS 27.4% − txn 6.3% − ads 50.4%  = $0.16
```

**A renewal dollar is worth 4.2× a new-checkout dollar.** Note AOV is near-identical on both ($108–113 vs $100–124), so the gap is **acquisition cost**, not first-order discounting.

> ⚠️ **Do not treat this as an independent lever.** Renewal share is high *because* ad spend is low — it is largely the same signal as Driver 1 read from the revenue side. The only way to raise it without mortgaging the future is to improve retention economics, not to cut acquisition.

---

## Driver 3 — LTV per acquired customer

Cumulative revenue per acquired customer, fixed m0–m3 horizon:

| Cohort | m1 retention | m0 rev/cust | **Cum m0–m3** |
|---|---|---|---|
| 2025-09 | 43% | $197 | **$357** |
| 2025-10 | 43% | $203 | $359 |
| 2025-11 | 34% | $198 | $312 |
| 2025-12 | 34% | $211 | $326 |
| 2026-01 | 36% | $196 | $300 |
| 2026-03 | 36% | $170 | $273 |

**Two separate hits, in sequence:**

1. **Nov 2025 – Jan 2026 — a retention hit.** m1 retention 43% → 34%. Cause never identified. **Recovered**: 39–40% by Apr/May 2026.
2. **Mar 2026 – Jul 2026 — an AOV hit.** First-order AOV $124 → $92, driven by a deliberate **1-unit default test** (CEO, to probe conversion rate). Reverted to a 2-unit default ~week of 2026-07-19.

### First-order AOV, weekly (the 1-unit test and its reversal)

| Week of | AOV | Units | % with discount |
|---|---|---|---|
| 2026-07-05 | $99 | 1.81 | 16% |
| **2026-07-12** | **$92** | **1.55** | 21% |
| 2026-07-19 | $104 | 2.00 | 10% |
| 2026-07-26 | $117 | 2.35 | 26% |
| 2026-08-09 | **$126** | **2.53** | 11% |
| 2026-08-16 | $116 | 2.24 | 21% |

Monthly: Jul **$102** → Aug (to 8/23) **$116**, units 1.89 → 2.23. **~60% recovered** toward the $123–132 of Sep 2025–Feb 2026.

> ⚠️ **Confounded.** Discount penetration fell 37–48% → 10–21% over the same weeks. Both raise AOV; they cannot be separated from this data.
>
> ⚠️ **The CVR half of the 1-unit test is unmeasurable here.** New-customer volume fell (125 in June → 80 in August) but ad spend collapsed from ~$2,200/day to ~$300/day over the identical window. A before/after cannot separate them — this needs a real split test with spend held constant.

---

## Drivers 4 & 5 — COGS and Fixed OpEx

**COGS** ranged 27–47% of income (ex-outlier). July's **27.4% is the series best** — little headroom left.

**Fixed OpEx** was the largest *historical* win and is now genuinely flat:

| Half | Avg fixed OpEx |
|---|---|
| 2024-H2 | $145K |
| 2025-H1 | $113K |
| 2025-H2 | $74K |
| 2026-H1 | $59K |
| 2026-H2 | $59K |

**$86K/month removed** — >$1M annualized. Treating G&A as a constant when explaining *history* erases the biggest realized win; treating it as constant *going forward* is now fair.

---

## What is NOT a driver

### Revenue volume
`r = −0.05` with profit — no relationship, slightly negative. The company has grown revenue while losing money and shrunk revenue while making it.

### Churn rate — structural, not movable
Twelve monthly cohorts across a **5× swing in ad spend**, revenue per acquired customer normalized to month 0:

| Month since acquisition | Mean multiple | Spread |
|---|---|---|
| m1 | 0.259 | **13.8%** |
| m2 | 0.198 | 17.8% |
| m3 | 0.177 | 18.9% |

Customer retention is equally tight — m1 lands 34–46%, m3 22–31%, m6 15–21%, in every cohort. The cliff-then-sticky shape is a property of the product (health & wellness: it works for some people and not others — CEO), not something to optimize.

**Corollary:** the aggregate churn % rising when intake rises is pure arithmetic — more young cohorts sitting inside their cliff. Don't read it as a deterioration.

### Collection rate — healthy
| Month | True collection (collected ÷ attempted) | Cancelled (% of book) | Paused (% of book) |
|---|---|---|---|
| 2026-05 | 91.5% | 6.7% | 7.5% |
| 2026-06 | 86.9% | 12.8% | 8.6% |
| 2026-07 | **85.1%** | 12.4% | **13.3%** |

> ~~Collection collapsed 82% → 64%, worth ~$21K/mo to recover.~~ **WRONG (2026-08-24).** That metric put *cancelled* and *paused* rows in the denominator of a "collection rate". Those are churn and deferral, not billing failures. True collection is **85% and healthy**. The one line still worth watching is **pauses, which doubled (169 → 352 rows)**.

### The 2nd sale — improving
% of a cohort placing a second order within 30 days: **49% (Sep 2025) → 69% (Jun 2026)**. Orders per customer in m0 rose 1.62 → 1.82. Cutting SMS/email promos did **not** cost the second sale.

---

## Unit economics

- **CAC** ≈ **$230** (July: $38.9K digital ads ÷ 169 new subs)
- **Cohort revenue realization**: $124 first order → $299 by d90 → $397 by d180 (2026-01, n=700)
- **Payback** ≈ **5 months** at 66% contribution
- **LTV/CAC** ≈ **1.7** — positive but thin, and cash-negative for most of a quarter

**Breakeven** at the current cost structure (72.6% GM, 6.3% txn, $59K fixed, $39K ads): **~$148K/month of income**, against $248K today.

### ⚠️ The strategic tension

The low-ad-load regime is **not a destination**. The subscriber base decays ~$10K of revenue/month and only acquisition replaces it — but acquisition currently costs $276–339 incremental against a $220 hold band. Net MRR is already negative: **churn $20.0K vs new subs $17.6K = −$2.4K/month**.

That's roughly **10 months of runway in the profitable regime** before the cost structure eats the profit. Fixing acquisition economics is not optional, it's timed.

---

## Measurement you cannot trust

Every one of these was found broken during this investigation. **Verify before relying on any of them.**

| Surface | State |
|---|---|
| `product_ad_account_mappings` | **0 rows** → `computeAcqROAS` returns null for every line. The Growth measurement spine was built and never seeded ([[../../libraries/acquisition-roas]]). |
| `media_buyer_sensor_trust` | **0 rows, ever.** The accuracy gate is bypassed in TRUST-META mode, which checks only signal *freshness*, never correctness ([[../../libraries/media-buyer-agent]]). |
| Bianca's cooldown rail | `per_object_cooldown_hours` is set but `recentActions` is never threaded into the runner — **0 call sites**. The rail cannot fire. |
| `iteration_actions.rationale` | Writes `"ROAS 0.95 ≥ scale_up_roas_trigger 1.00"` — the ROAS gate is skipped in TRUST-META mode but the string still claims it passed. The audit ledger is not trustworthy. |
| Google Ads spend | **No table, no integration.** ~$130/30d, branded-defense only (CEO) — small, but invisible to every blended calculation. |
| Meta's pixel | **Over**-reports on-site: claimed 6 purchases on 2026-08-20 where Shopify first-touch credits 3. Not under-reporting. |
| Amazon halo | Amazon acquisition orders **rose** as Meta spend fell 77% (8 → 19/day). Same-day it is uncorrelated; a lagged effect is untested. Do not credit Amazon revenue to Meta without re-establishing this. |
| Shopify "Total sales" tile | Includes ~68 renewals/day. Shopify's **conversion rate** is `new checkouts ÷ sessions` and matches our bucketing exactly (3.31% on 8/20 = 10/302). The two tiles measure different populations. |

---

## Findings log

### 2026-08-24 — initial investigation (CEO + Claude)
Triggered by: "Thursday/Friday were great, Saturday cooled, Sunday was a dud — did our own system unoptimize us?"

**Answer: no.** The kill decisions were directionally correct and arguably late. Thu/Fri were the middle of an 8-ad test wave (partly manual); Sat/Sun produced exactly normal weekend volume (6 and 5 new checkouts vs a 4–6 norm). The apparent collapse was a return to baseline.

Established: the two regimes · revenue ⊥ profit · marginal ad return 0.74 · churn shape structural · the Nov-2025 retention hit and the Mar-2026 AOV hit · contribution 4.2× · breakeven $148K.

**Corrections made in-session** (kept so they aren't re-derived):
- ~~"Meta sees ~5% of reality"~~ — compared Meta purchases against *all* orders including renewals. True comparison is 6 claimed vs ~10 real on-site.
- ~~"Amazon halo justifies crediting Amazon to Meta"~~ — fails the natural experiment.
- ~~"Collection rate collapsed to 64%"~~ — denominator error, see above.
- ~~"m1 retention dropped and stayed down"~~ — it recovered to 40%.
- ~~"NULL `subscription_id` silently corrupts bucketing"~~ — overstated; 2 orders/month. Real impact was the portal order-history widget. Fixed in #2551.
- ~~"40% less revenue, 24× the profit"~~ — the high-ad-load regime average included the 2024-12 write-off. Excluding it the split is **2.1× the profit / 3.5× the margin**, which is still decisive but not theatrical. Caught by running the reproducible script against the hand-written page.

### 2026-08-24 — shipped
- **#2549** — [[../../dashboard/analytics__profit]] rebuilt on real QuickBooks data ([[../../libraries/profit-estimate]]). The old page reported $46,065 for July against a real $65,458.
- **#2551** — subscription first-order linkage ([[../../libraries/subscription-order-link]]); 1,088 orders backfilled.

---

## Open questions

1. **What caused the Nov 2025 – Jan 2026 retention hit?** m1 fell 43% → 34% and cost ~18% of LTV. Recovered, cause unknown. Worth understanding so it isn't repeated.
2. **Did the 1-unit default actually raise CVR?** Unanswerable from before/after — needs a split test with spend held constant.
3. **Is the Amazon halo real on a lag?** Same-day it's uncorrelated. A 7–14 day lagged correlation against Meta spend would settle it, and it changes every blended CAC number.
4. **Why is `pause` on the renewal book doubling?** 169 → 352 rows May → July. Deferral, not churn, but it's the fastest-moving line.
5. **Can acquisition reach ≤$220 CAC?** The timed question. Ten months of runway.

---

## How to re-run

`scripts/_profit-drivers.ts` — read-only, DB-only, **zero external API calls** (Appstle bills per hit — never bulk-loop it). Emits the regime split, the correlation table, the G&A series, the cohort curves, and the current-month unit economics.

Sources: [[../../tables/qb_pnl_snapshots]] · [[../../tables/orders]] · [[../../tables/daily_order_snapshots]] · [[../../tables/daily_amazon_order_snapshots]] · [[../../tables/daily_meta_ad_spend]] · [[../../tables/billing_forecasts]] · [[../../libraries/order-bucketing]].

**Method notes that matter:**
- Always exclude **2024-12** from correlations (inventory write-off, COGS 143% of income).
- Always dedupe cohorts against a **long lookback** — deduping inside the reporting window counts returning buyers as new and inflated July's first-order AOV from $102 to $115.
- Control for **day-of-week** on spend-response reads; a naive low/high split compared weekend-heavy to weekday-only periods.
- Page every daily-table read past the **1000-row cap** — a single ranged select silently truncates.

## Related

[[../cfo]] · [[../../libraries/profit-estimate]] · [[../../dashboard/analytics__profit]] · [[../../libraries/acquisition-roas]] · [[../../libraries/blended-cac-ltv]] · [[../../libraries/media-buyer-agent]] · [[../../tables/qb_pnl_snapshots]] · [[../../libraries/order-bucketing]] · [[../../dashboard/analytics__mrr]]

---

[[../../README]] · [[../../../CLAUDE]]
