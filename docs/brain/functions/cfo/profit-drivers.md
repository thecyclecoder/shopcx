# What drives profit

**Measured, not assumed.** Owner: [[../cfo]] (Grace).

A **living investigation page**. Profit, not revenue, is the CEO north star ([[../cfo]] § Mandates), and almost every intuition about what moves it — including several of this page's own earlier conclusions — turned out wrong when checked against 25 closed months of QuickBooks P&L and 12 monthly customer cohorts.

Every number is **measured** unless labelled otherwise. Wrong conclusions are **struck through, not deleted** — the point is to stop a future session re-deriving a disproven answer. Add to the [findings log](#findings-log); don't silently rewrite history.

**Re-run:** `scripts/_profit-drivers.ts` · `_scale-curve.ts` · `_cogs-normalize2.ts` · `_amazon-halo.ts` (all read-only, DB-only, **zero external API calls** — Appstle bills per hit).

---

## ⭐ The headline

> **The business is currently UNDER-spending on acquisition, and today's 26% margin is the symptom, not the achievement.**

At ~$41K/month of Meta spend the business earns a 26% margin on a **shrinking** base. Steady state on that path is roughly **$4K/month of profit**. Stepping spend up toward **$100–120K/month** produces less headline margin (~15–20%) but **more durable profit on a stable or growing base**.

The ceiling is real but higher than the current level: above ~$150K/month the margin thins to ~7%, and above ~$180K it approaches zero.

---

## What "profit" means here

Two first-class lines, moving in opposite directions **on purpose** ([[../../tables/qb_pnl_snapshots]] § The two profit lines):

- **`net_income`** — booked. Steered **≤ $0 per fiscal year** for US tax.
- **`adjusted_net_income` = `net_income` + `management_fees`** — the intercompany PR→TX transfer-pricing fee added back. **This is "real profit" and the number to grow.**

July 2026: `$5,458` booked + `$60,000` fees = **`$65,458` real profit** on `$248,420` income = **26.3% margin**.

Surfaced by [[../../libraries/profit-estimate]] → [[../../dashboard/analytics__profit]].

---

## ⭐ CAC: use the blended number

**CEO directive 2026-08-24:** *"It doesn't matter if a customer would have arrived anyway, because we will never know. People see ads, don't click, search us, and buy — the ad drives the awareness. Hoping an organic customer shows up is not a lever."*

**Correct, and it is the operating frame.** The only dial is ad spend. The metric is:

```
blended CAC = total Meta spend ÷ total new customers (website + Amazon)
```

July 2026: `$41,184 ÷ 749 = $55` · LTV `$208.93` · **LTV:CAC 3.8×**. August MTD: **$41 · 5.6×**.

Surfaced on [[../../dashboard/analytics__roas]].

> **Why not incremental CAC?** A regression on 19 months implies ~618 customers/month would arrive at $0 spend, which would put incremental CAC at $136–314. But observed spend **never drops below $30K/month**, so that intercept is pure extrapolation. A linear fit (r² 0.83) and a diminishing-returns fit (r² 0.74) explain the observed range equally well and **disagree completely** below it — at $15K/mo one predicts 728 customers and the other 269. The data cannot choose, and the "organic baseline" is not an option we can actually take. Blended CAC is the decision metric.

---

## ⭐ The scale curve — the most actionable table here

Blended CAC as spend moved 8× (`_scale-curve.ts`):

| Ad spend band | Months | Avg spend | New customers/mo | **Blended CAC** | **LTV:CAC** |
|---|---|---|---|---|---|
| under $50K | 5 | $39K | 919 | **$42** | **5.0×** |
| $50–120K | 2 | $101K | 1,463 | **$69** | **3.0×** |
| $120–180K | 10 | $149K | 1,677 | $89 | 2.3× |
| over $180K | 2 | $213K | 2,267 | $94 | 2.2× |

**At a 3× LTV:CAC target the CAC ceiling is ~$70 — which sits around $100–120K/month of spend.** Current spend is $41K.

### Profit at steady state

Steady state = `customers/month × LTV`, at the July cost structure:

| Monthly ad spend | Customers/mo | Steady-state revenue | **Steady-state profit** | Margin |
|---|---|---|---|---|
| **$41K (today)** | 749 | ~$157K | **~$4K** | 2.6% |
| $75K | ~1,190 | ~$248K | ~$30K | 12% |
| **$101K** | ~1,460 | ~$306K | **~$44K** | **14%** |
| $149K | 1,677 | ~$350K | ~$24K | 6.9% |

**Profit rises with spend up to ~$100–120K/month, then falls.** Today's high margin is a harvest of the base 2025's spend built.

**Operating rule: raise spend until blended CAC crosses ~$70, then stop.**

---

## ⭐ 2025 WAS profitable — and one December entry hid it

**CEO 2026-08-24:** a former CFO wasn't expensing inventory correctly, forcing a large write-off.

Confirmed, and isolated (`_cogs-normalize2.ts`):

| Month | Product COGS | vs 31% normal | **Excess** | Reported → restated |
|---|---|---|---|---|
| **2024-12** | **101% of income** | 31% | **$441K** | −$561K → −$121K |
| 2025-03 | 47% | 31% | $93K | $47K → $140K |

**$534K total.** December 2024 booked **$896K of COGS on $626K of income**.

### The trap: 2024's "68% COGS" is NOT inventory

Before 2025, **ad spend was booked inside COGS** as per-channel accounts — the Dec-2024 detail literally shows `Ads - Facebook (deleted) $245K` ([[../../tables/qb_pnl_snapshots]] § the ad-account bridge). Strip ads out and 2024 product COGS was a normal **23–33%**.

**So only ONE month is a genuine write-off, not the whole year.** Normalizing *total* COGS across 2024 adds real ad spend back as an "error" and invents ~43% margins. Always compare **product COGS = `total_cogs` − ads-booked-in-COGS**.

### And it does not rescue the scale story

| Ad spend band | Months | **Reported margin** | **Restated margin** |
|---|---|---|---|
| under $50K | 5 | 27.5% | **27.5%** |
| $50–120K | 2 | 9.5% | 19.8% |
| **$120–180K** | **8** | **7.4%** | **7.4%** |
| over $180K | 10 | −3.4% | 3.1% |

The $120–180K band is **eight months of 2025 with clean books and no write-off** — reported and restated are identical.

**2025 calendar year: $303K reported real profit on $5.87M income (5.2%), or $396K restated (6.8%).** Thinly profitable, not a loss year. Only Oct and Nov 2025 went negative, and both had clean books — they were genuinely over-spent at $169K and $195K.

---

## The Amazon halo is real

`corr(monthly Meta spend, monthly Amazon acquisition orders) = 0.78` (n=19). Lagged weekly it holds at **0.64 for 0–2 weeks**, decaying to 0.43 by week 4.

An adstock model (accumulated brand awareness, `S_t = spend_t + λS_{t-1}`) fits **worse** than current-month spend (best λ=0, r² 0.53 vs 0.61) — so Amazon demand tracks *current* spend, not a slowly-melting stock of past advertising.

There is **no separate Amazon ad spend**: July's P&L shows `60510 Digital Advertising $38,891` against $41,184 of Meta spend in our own table. No Amazon PPC line exists.

---

## Other drivers

### Revenue mix — a consequence, not a dial
`corr(renewal share, profit margin) = 0.92` (n=7). Contribution per revenue dollar, July:

```
RENEWAL       $1.00 − COGS 27.4% − txn 6.3%              = $0.66
NEW CHECKOUT  $1.00 − COGS 27.4% − txn 6.3% − ads 50.4%  = $0.16
```

AOV is near-identical on both ($108–113 vs $100–124), so the 4.2× gap is **acquisition cost**, not discounting. But renewal share is high *because* spend is low — largely the same signal as the scale curve, read from the revenue side. Not an independent lever.

### LTV per acquired customer — took two hits, one recovering

| Cohort | m1 retention | m0 rev/cust | Cum m0–m3 |
|---|---|---|---|
| 2025-09 | 43% | $197 | **$357** |
| 2025-11 | 34% | $198 | $312 |
| 2026-01 | 36% | $196 | $300 |
| 2026-03 | 36% | $170 | $273 |

1. **Nov 2025 – Jan 2026 — retention hit.** m1 43% → 34%. Cause never identified. **Recovered** to 39–40% by Apr/May.
2. **Mar – Jul 2026 — AOV hit.** First-order AOV $124 → $92, from a deliberate **1-unit default test** (CEO, probing conversion rate). Reverted to a 2-unit default ~week of 2026-07-19.

Weekly recovery: Jul 12 **$92 / 1.55 units** → Jul 26 $117 / 2.35 → Aug 9 **$126 / 2.53** → Aug 16 $116 / 2.24. Monthly Jul **$102** → Aug **$116**.

> ⚠️ Confounded — discount penetration also fell 37–48% → 10–21% over the same weeks. Both raise AOV.
>
> ⚠️ The CVR half of the 1-unit test is **unmeasurable** from before/after: ad spend collapsed over the identical window. Needs a split test with spend held constant.

**Rising LTV raises the CAC ceiling**, so the room to scale is currently widening.

### COGS and Fixed OpEx
Product COGS is stable at **~31%** and July's 27.4% is the series best. Fixed OpEx fell **$145K → $59K** per half-year (2024-H2 → 2026-H1) and is now flat — the largest historical win, but no longer a live lever.

---

## What is NOT a driver

### Churn rate — structural, not movable
Twelve cohorts across a **5× swing in ad spend**, revenue normalized to month 0:

| Month since acquisition | Mean multiple | Spread |
|---|---|---|
| m1 | 0.259 | **13.8%** |
| m2 | 0.198 | 17.8% |
| m3 | 0.177 | 18.9% |

Customer retention is equally tight — m1 34–46%, m3 22–31%, m6 15–21%, every cohort. The cliff-then-sticky shape is a property of the product (health & wellness: it works for some people and not others — CEO), not something to optimize.

**Corollary:** aggregate churn % rising when intake rises is pure arithmetic — more young cohorts inside their cliff. Not a deterioration.

### Collection rate — healthy
True collection (`collected ÷ attempted`): 91.5% (May) → 86.9% (Jun) → **85.1% (Jul)**. Watch **pauses**, which doubled (169 → 352 rows).

### The 2nd sale — improving
% of a cohort placing a second order within 30 days: **49% (Sep 2025) → 69% (Jun 2026)**. Cutting SMS/email promos did **not** cost the second sale.

### Revenue volume alone
`corr(income, real profit) = −0.05` across 24 clean months. Revenue without regard to how it was bought tells you nothing about profit.

---

## Measurement you cannot trust

| Surface | State |
|---|---|
| `product_ad_account_mappings` | **0 rows** → `computeAcqROAS` returns null ([[../../libraries/acquisition-roas]]). |
| `media_buyer_sensor_trust` | **0 rows, ever.** The accuracy gate is bypassed in TRUST-META mode, which checks only *freshness* ([[../../libraries/media-buyer-agent]]). |
| Bianca's cooldown rail | `per_object_cooldown_hours` is set but `recentActions` is never threaded — **0 call sites**. The rail cannot fire. |
| `iteration_actions.rationale` | Writes `"ROAS 0.95 ≥ scale_up_roas_trigger 1.00"` — the gate is skipped in TRUST-META mode but the string claims it passed. |
| Google Ads spend | **No table, no integration.** ~$130/30d, branded-defense only (CEO). |
| Meta's pixel | **Over**-reports on-site: claimed 6 purchases on 2026-08-20 where Shopify first-touch credits 3. |
| Shopify "Total sales" tile | Includes ~68 renewals/day. Shopify's **conversion rate** is `new checkouts ÷ sessions` and matches our bucketing exactly (3.31% on 8/20 = 10/302). |
| Pre-2025 COGS | Contains ad spend. Never compare raw `total_cogs` % across the 2025 boundary. |

---

## Findings log

### 2026-08-24 (session 1) — "did our own system unoptimize us?"
**Answer: no.** The media-buyer kills were directionally correct. Thu/Fri were the middle of an 8-ad test wave (partly manual); Sat/Sun produced exactly normal weekend volume.

Established: churn shape structural · revenue ⊥ profit · contribution 4.2× · the Nov-2025 retention hit and Mar-2026 AOV hit.

### 2026-08-24 (session 2) — the scale question
Triggered by: *"revenue declines every month, but margin is 22% — does the margin evaporate, or can we cruise?"*

**Answer: neither. Cruising is the one option that isn't available** — holding spend at $41K glides to ~$4K/month profit. Established the scale curve, the ~$70 CAC ceiling, and the December-2024 write-off.

### Corrections (kept so they aren't re-derived)
- ~~"Meta sees ~5% of reality"~~ — compared Meta purchases against *all* orders including renewals.
- ~~"The Amazon halo fails the natural experiment"~~ — drawn from a **5-day window**. Over 19 months `r = 0.78`. The halo is real.
- ~~"Collection rate collapsed to 64%"~~ — put cancelled + paused rows in the denominator of a *collection* rate.
- ~~"m1 retention dropped and stayed down"~~ — recovered to 40%.
- ~~"40% less revenue, 24× the profit"~~ — included the 2024-12 write-off in the regime average. True split is 2.1× profit / 3.5× margin.
- ~~"2025 was unprofitable"~~ — **it made $303K (5.2%), or $396K restated (6.8%).** Only Oct/Nov went negative.
- ~~"Incremental CAC is $230, so accept a smaller business"~~ — wrong metric *and* wrong conclusion. Blended CAC is $55 and the business is under-spending.
- ~~"~618 customers/month arrive at zero spend"~~ — extrapolated $30K below any observed month; a diminishing-returns fit explains the same data and predicts near-zero. Unknowable without a test.
- ~~Normalizing total COGS across 2024~~ — adds ads-booked-in-COGS back as an accounting error and invents 43% margins.

### Shipped
- **#2549** — [[../../dashboard/analytics__profit]] rebuilt on real QuickBooks data ([[../../libraries/profit-estimate]]). Old page reported $46,065 for July against a real $65,458.
- **#2551** — subscription first-order linkage ([[../../libraries/subscription-order-link]]); 1,088 orders backfilled.
- **#2552** — this page.

---

## Open questions

1. **Step spend toward $100K/month and watch blended CAC.** The stopping rule is CAC > $70. This is the live decision.
2. **What caused the Nov 2025 – Jan 2026 retention hit?** Cost ~18% of LTV, recovered, cause unknown.
3. **Did the 1-unit default actually raise CVR?** Needs a split test with spend held constant.
4. **Why are pauses doubling** on the renewal book (169 → 352 rows, May → Jul)?
5. **The media buyer optimizes on Meta-reported CPA** — 2× optimistic, blind to Amazon and to LTV. A cheaper, smaller, more-discounted offer looks *better* to it while producing a less valuable customer. Nothing in that loop sees any of the economics on this page.

---

## How to re-run

All read-only, DB-only, **zero external API calls**.

| Script | Answers |
|---|---|
| `_profit-drivers.ts` | regimes, correlations, G&A series, cohort curves, breakeven |
| `_scale-curve.ts` | blended CAC by spend band → the CAC ceiling |
| `_cogs-normalize2.ts` | isolates the write-off from the ads-in-COGS structure |
| `_amazon-halo.ts` | halo correlation + lags + natural experiments |
| `_steady-state.ts` / `_trajectory.ts` | equilibrium revenue and the path to it |

**Method traps that produced wrong answers:**
- Exclude **2024-12** from correlations (write-off, product COGS 101% of income).
- **Product COGS = `total_cogs` − ads-in-COGS** for any pre-2025 month.
- Dedupe cohorts against a **long lookback** — deduping inside the window counts returning buyers as new (inflated July first-order AOV $102 → $115).
- Control for **day-of-week** on spend-response reads.
- Page every daily-table read past the **1000-row cap**.
- **Never conclude from a <2-week window** — the 5-day Amazon read produced a confidently wrong answer that stood for hours.

## Related

[[../cfo]] · [[../../libraries/profit-estimate]] · [[../../dashboard/analytics__profit]] · [[../../dashboard/analytics__roas]] · [[../../libraries/acquisition-roas]] · [[../../libraries/blended-cac-ltv]] · [[../../libraries/media-buyer-agent]] · [[../../tables/qb_pnl_snapshots]] · [[../../libraries/order-bucketing]] · [[../../dashboard/analytics__mrr]]

---

[[../../README]] · [[../../../CLAUDE]]
