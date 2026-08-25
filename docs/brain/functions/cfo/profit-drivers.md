# What drives profit

**Measured, not assumed.** Owner: [[../cfo]] (Grace).

A **living investigation page**. Profit, not revenue, is the CEO north star ([[../cfo]] § Mandates), and almost every intuition about what moves it — including several of this page's own earlier conclusions — turned out wrong when checked against 25 closed months of QuickBooks P&L and 12 monthly customer cohorts.

Every number is **measured** unless labelled otherwise. Wrong conclusions are **struck through, not deleted** — the point is to stop a future session re-deriving a disproven answer. Add to the [findings log](#findings-log); don't silently rewrite history.

**Re-run:** `scripts/_profit-drivers.ts` · `_scale-curve.ts` · `_cogs-normalize2.ts` · `_amazon-halo.ts` · `_ramp-plan.ts` · `_stock-picture.ts` (all read-only, DB-only, **zero external API calls** — Appstle bills per hit).

---

## ⭐ The headline

> **The business is currently UNDER-spending on acquisition, and today's 26% margin is the symptom, not the achievement.**

At ~$41K/month of Meta spend the business earns a 26% margin on a **shrinking** base. Steady state on that path is roughly **$4K/month of profit**. Stepping spend toward **~$100K/month** produces less headline margin (~14%) but **more durable profit on a stable base**.

**The plan (CEO):** **Phase 0 → restock FBA (blocking — Amazon is 66% of acquisition and has ~32 days of stock, nothing inbound).** Phase 1 → $55K/month to match cancels, website-only while Amazon is dark. Phase 2 → +15%/month toward ~$100K, cash-paced, gated on Phase 0. **Stop whenever blended CAC crosses $110; never exceed $139** (break-even = LTV × contribution margin). See [§ The staged plan](#-the-staged-plan-ceo-2026-08-24).

The ceiling is **~$100K/month**, where the *marginal* customer starts costing more than they return — not the $150–180K the band averages suggest.

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

> ⚠️ **These are band AVERAGES. Do not size a ramp from them** — see § The ceiling below. An average CAC of $89 at $149K/month hides a *marginal* CAC of $224 for the customers between $101K and $149K.

### ⭐ The ceiling — derived, not benchmarked

> ~~**At a 3× LTV:CAC target the CAC ceiling is ~$70.**~~ **Wrong.** $70 is just `$209 ÷ 3` — an imported DTC convention, not anything derived from this business. It caps spend at roughly half of what the economics actually support.

**Break-even CAC** is where a customer's lifetime contribution equals what you paid:

```
LTV $209 × contribution margin 66.3% = $139
```

Above $139 blended CAC a customer destroys value; below it, it adds. That is the real hard ceiling.

But the decision is about the **marginal** customer, not the average. Band-to-band:

| Step | Δ spend | Δ customers | **Marginal CAC** | vs $139 break-even |
|---|---|---|---|---|
| $39K → $101K | $62K | +544 | **$114** | ✅ profitable (+$25/customer) |
| $101K → $149K | $48K | +214 | **$224** | ❌ **destroys value** |
| $149K → $213K | $64K | +590 | $108 | ⚠️ n=2 band, 2025 economics — don't trust |

**The wall is around $100K/month**, where marginal CAC crosses break-even. Not $150–180K.

Practical operating rule, with margin for LTV being wrong:

- **Hold at any level where blended CAC crosses $110** — the signal you've entered the $224 marginal zone.
- **Never exceed $139** blended CAC.

> ⚠️ **Everything above scales linearly with LTV.** The $208.93 blended LTV is the dashboard's own *uncalibrated* figure. At $250 LTV break-even is $166; at $180 it's $119 and the ramp barely works. **Re-derive the ceiling whenever LTV is recalibrated.**

### Profit at steady state

Steady state = `customers/month × LTV`, at the July cost structure:

| Monthly ad spend | Customers/mo | Steady-state revenue | **Steady-state profit** | Margin |
|---|---|---|---|---|
| **$41K (today)** | 749 | ~$157K | **~$4K** | 2.6% |
| $75K | ~1,190 | ~$248K | ~$30K | 12% |
| **$101K** | ~1,460 | ~$306K | **~$44K** | **14%** |
| $149K | 1,677 | ~$350K | ~$24K | 6.9% |

**Profit rises with spend up to ~$100K/month, then falls.** Today's high margin is a harvest of the base 2025's spend built.

---

## ⭐ The staged plan (CEO 2026-08-24)

> **Phase 1** — match incoming subs with cancels ("stay flat").
> **Phase 2** — raise acquisition **slowly**. Meta is paid on credit cards, so this month's spend is next month's payment. No $30K → $100K jumps.

**The binding constraint is CASH, not CAC.** A customer costs money today and repays over ~5 months, so a ramp faster than the payback period compounds the cash gap even when every cohort is profitable.

### ⭐ Phase 0 — INVENTORY. This gates everything (CEO 2026-08-24)

> **You cannot buy a customer you cannot ship to.** Checked before any ramp; canonical source is [[../../tables/inventory_levels]] (`location='amplifier_3pl'` / `'fba'`), fed daily from Amplifier by [[../../inngest/sync-3pl-inventory]] — **not** the `qb_*_inventory_snapshots` tables, which are the accounting rollup.

| Path | On hand | Inbound | State |
|---|---|---|---|
| **3PL (website)** | **102,995 units** | 0 | ✅ abundant — Tabs 7,268 · Ashwavana 6,359 · Creamer 6,338 · Creatine 4,679 |
| **FBA (Amazon)** | 843 (165 reserved → **678 net**) | **0** | ❌ **27 of 45 SKUs at zero. None above 200. Nothing on the way.** |

**Amazon is 66% of acquisition** (492 of 749 new customers in July). At July's Amazon run rate (~21 orders/day) that's **~32 days of runway** — optimistic, since the sellers are at zero and the remaining units sit in slow SKUs.

**What an empty FBA does to the ramp**: the 7.38 customers/$1K response was measured with FBA in stock. Website-only, the effective response falls to ~2.53/$1K ⇒ **marginal CAC ~$395**.

> ⚠️ ~~"That's 2.8× break-even."~~ **Wrong — it compares against the BLENDED break-even.** The blend is dragged down by Amazon. Split (July dashboard): **Website LTV $365 · Amazon LTV $127 · blended $209**. Website-only break-even is `$365 × 66.3% = $242`, so website-only ramping runs at **~1.6× break-even**, not 2.8×. Underwater, but far less so — **and a website customer is worth nearly 3× an Amazon one.**

**Coffee is the smaller constraint.** Whole-bean Coffee is out (ASC-COFFEE-1 at 5 units, ASC-COFFEE-3 at 0) and its ad account already runs **zero active adsets**, so it's largely priced in. But **K-Cups have stock**:

| | Units |
|---|---|
| K-Cups, 3PL (website) | **3,900** (`SC-COFFEEPOD-NP24`) ≈ 3,500 orders of headroom |
| K-Cups, FBA (Amazon) | **30 net** — website-only lever |

K-Cups ran **~31 orders/month while barely advertised** at **$89 AOV / 64% sub rate**. It won't carry Phase 1 alone (+102 customers/month needed) but it's an unconstrained SKU to push — and the only coffee-adjacent product sellable today.

> ⚠️ **Set K-Cups its own CAC target.** At $89 AOV vs Tabs' $126 its LTV — and therefore its ceiling — is lower than the blended number.

**Phase 0 exit condition:** FBA restocked. Until then, Phase 1 runs website-only and Phase 2 is blocked — not because the economics collapse, but because two-thirds of the volume can't be reached.

### Phase 1 — $41K → $55K/month

Churn **$20.0K** MRR vs new-sub **$17.6K** ⇒ **13.6% more new subs** needed to hold flat. At the measured marginal response (7.38 customers per $1K):

| | Now | Phase 1 |
|---|---|---|
| Spend | $41K/mo ($1,370/day) | **$55K/mo ($1,830/day)** |
| Total new customers | 749 | ~851 |
| Blended CAC | $55 | **~$65** |

Marginal CAC on this step is ~$114 against a $139 break-even — genuinely profitable, and it protects the ~618/month baseline that carries essentially all the profit. **~$14K/month more on the card.**

> ⚠️ **While FBA is empty, point Phase 1 at WEBSITE conversion** — Tabs, Creamer, Ashwavana, Creatine, K-Cups — where 3PL holds 103K units and a customer is worth **$365**, not $209. Expect worse than the $65 blended CAC projected above: that projection assumed Amazon carried two-thirds of the conversions. The compensating factor is the higher website LTV, which lifts the break-even to $242.

### Phase 2 — +15%/month to ~$100K

Incremental cash cost versus holding at $41K (the delta the card float must fund):

| Ramp rate | Deepest incremental cash hole |
|---|---|
| **+15%/month** | **~$270K** by month 10 |
| +25%/month | ~$227K by month 7 |
| +40%/month | ~$275K by month 7 |

A faster ramp digs a **deeper** hole for the same endpoint — spend leaves immediately, the cohort repays over ~5 months.

**+15%/month reaches ~$100K in about five months and keeps the monthly card increase under ~$10K.**

Be clear what Phase 2 buys: between $55K and $100K you acquire at ~$114 against a $139 break-even — about **$25 of profit per customer**. Real, but thin. It is mostly **converting cash into revenue slightly better than break-even**, and its main value is arresting the decline of the profitable base.

**Stop rule:** hold the level for a month whenever blended CAC crosses **$110**.

> 🚧 **Phase 2 is GATED on Phase 0.** Ramping to ~$100K with Amazon dark means buying at ~$395 against a $242 website break-even. Restock FBA first.

Model: `scripts/_ramp-plan.ts`.

---

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

## ⭐ The basis problem — why the media buyer strangled spend

**CEO 2026-08-24:** *"Meta-reported CPA is not 2× optimistic — Shopify is just underreporting."* Correct. Shopify first-touch only ever sees a **click**. It structurally cannot see a view-through (saw the ad, didn't click, searched the brand later), a cross-device purchase, an ITP-truncated session, or **anything on Amazon**. Those arrive labelled branded-search, direct, or organic.

So Meta-reported CPA isn't a *worse* number — it's a **different denominator**. Measured over the three months with clean insights coverage:

| Month | Meta CPA | Blended CAC | Ratio |
|---|---|---|---|
| 2026-05 | $326 | $48 | 6.8× |
| 2026-06 | $267 | $45 | 6.0× |
| 2026-07 | $347 | $54 | 6.4× |

**Meta-reported CPA runs ~6.4× blended CAC.** The media buyer's thresholds are absolute dollar figures compared against *Meta's* number, but were set as if Meta CPA were true CAC — so the old $220 kill line demanded a blended CAC of ~$34 while the business ran a healthy ~$54.

**The agent wasn't malfunctioning. It was correctly enforcing a threshold on the wrong basis** — 17 actions in a week, account down to 2 live adsets at $300/day.

### Re-based 2026-08-24 (CEO)

| Threshold | Was | Now | Blended equivalent |
|---|---|---|---|
| `crown_max_cpa_cents` | $150 | **$240** | ~$37 (5.6× LTV:CAC) |
| `hold_band_max_cpa_cents` | $220 | **$450** | ~$70 blended — see note |
| `slow_kill_max_cpa_cents` | $300 | **$600** | must exceed the hold band |

> ⚠️ **The slow-kill move is not optional.** [[../../libraries/testing-results-sdk]] `tierForTest` evaluates the slow-kill rule **before** the hold band (`testing-results-sdk.ts:93` vs `:95`), so past `slow_kill_min_spend_cents` ($600) the slow-kill ceiling **is** the effective kill line. Raising the hold band alone changes almost nothing. Keep `slow_kill_max_cpa_cents > hold_band_max_cpa_cents` — the 1.36× ratio is preserved.

> **Why $450 and not higher.** $450 ÷ 6.4 = ~$70 blended, which is *conservative* against the $139 break-even — deliberately. This is a **per-adset** kill line, not the account ceiling. Setting it at the account-level break-even would keep every below-average adset alive; the point is to cull the weak ones while the account blend stays comfortably profitable. If LTV is recalibrated upward, revisit — the hard floor is that no adset above `$139 × 6.4 ≈ $890` Meta CPA can ever be worth keeping.

Applied by `scripts/_retune-media-buyer-cpa-thresholds.ts` (idempotent; writes a `media_buyer_cpa_thresholds_rebased` [[../../tables/director_activity]] row). **Re-measure the 6.4× ratio periodically** — it moves with ATT, creative mix, and the Amazon share.

## ⭐ The Amazon halo is real — and it arrives ~12 DAYS LATE (measured 2026-08-25)

`corr(monthly Meta spend, monthly Amazon acquisition orders) = 0.78` (n=19). There is **no separate
Amazon ad spend**: July's P&L shows `60510 Digital Advertising $38,891` against $41,184 of Meta spend
in our own table. No Amazon PPC line exists. So Meta spend is the only lever on Amazon demand.

The CEO's long-standing observation — *"Amazon results trail a spend ramp by a few days"* — was tested
on 601 days of daily history (2025-01-01 → 2026-08-24). **It is correct in direction; the lag is
roughly twice what it feels like.**

### The response curve

| | peak lag | slope (orders/day per +$1,000/day) |
|---|---|---|
| **Website** | **day 0** | 2.79 |
| **Amazon** | **day 12** | 2.46 · 95% CI 1.44–4.79 |

Amazon's response is **diffuse across roughly days 4–20**, not a sharp delay. Half the response has
not landed by day 7.

### Why the naive test says "no effect" — and why that is not the answer

At daily resolution, deseasonalized, Amazon's peak correlation with spend is **r=0.091 at lag 0 —
below the 95% chance threshold (0.165)**. That null is *real but narrow*: it rules out a FAST response,
nothing more. Power check — the daily test could have detected ≥1.14 orders per $1,000/day (website's
is 2.79), so a fast effect of meaningful size is genuinely excluded.

The relationship only becomes visible at **~21-day smoothing** (r=0.542 at lag 12). And that is exactly
the width at which two series that merely drift together will correlate for reasons unrelated to
advertising — so smoothing alone proves nothing.

### The check that makes it a finding rather than an artifact

If spend *causes* Amazon orders, the correlation must be **asymmetric in time**: stronger when spend
leads than when orders lead. Shared trend/seasonality is symmetric. At 21-day smoothing:

```
lag -12   r = 0.072      ← Amazon leads
lag   0   r = 0.342
lag +12   r = 0.542  ◄ peak   ← spend leads
mean spend-leads +0.231   vs   orders-lead +0.025
```

**Asymmetric toward spend-leading.** Website is carried as a positive control throughout and peaks at
lag 0 at every smoothing width, which is what proves the test can detect a response at all.

### ⭐ The operating rule this forces

**Never judge a spend change before ~day 14.** A day-7 read sees the website response only and will
systematically overstate marginal CAC. This is not a caveat — it is the single most load-bearing
measurement rule on this page, and it invalidated a same-day conclusion (below).

### Caveats — do not quote this as settled

1. **Observational, not experimental.** Confound: we ramp spend when we have stock and launches. If
   restocks tend to precede spend ramps by ~2 weeks, that reproduces this exact signature with no
   causation. Only a held-out geo test or a pre-registered step-change settles it.
2. **Not stable across every spec.** At 28-day smoothing the asymmetry test reads "symmetric"
   (+0.047). Explainable — smoothing wider than the lag blurs the asymmetry away — but it is a real
   limit, not one to bury. Effective sample at 21d is ~29 independent windows; the slope CI spans
   1.44–4.79, a 3.3× range. **The lag is "~1–2 weeks", not "12 days" to the day.**
3. **The historical slope may not apply while FBA is starved.** It was measured over periods when
   Amazon had stock to convert the halo. A halo cannot land on an out-of-stock listing — see § Phase 0.

### ~~Amazon demand tracks *current* spend, not past advertising~~ — SUPERSEDED

~~Lagged weekly the correlation holds at 0.64 for 0–2 weeks, decaying to 0.43 by week 4. An adstock
model (`S_t = spend_t + λS_{t-1}`) fits worse than current-month spend (best λ=0, r² 0.53 vs 0.61) —
so Amazon demand tracks current spend, not a slowly-melting stock of past advertising.~~

**Why it was wrong:** weekly buckets are too coarse to separate lag 0 from lag 12, and the adstock fit
was run on *monthly* data where a 12-day lag is inside the bucket and therefore invisible by
construction. Both readings are consistent with the daily curve above; neither could see it. The
λ=0 result should never have been read as "no delayed response" — it only says "no slowly-melting
multi-month stock", which remains true.

### Consequence for the media buyer (supervision, not a bug)

Bianca kills on `pause_window_days = 3` and can ratchet budget every 24h. That is defensible for her
own proxy — she optimizes Meta-attributed purchases, which respond at lag 0. But it means the control
loop runs **~12× faster than the feedback signal for the objective that actually matters** (total new
customers). That is the Goodhart pattern in [[../../operational-rules]] § North star: a bounded proxy,
optimized fast, with nobody watching the gap. Flagged for [[../media-buyer]] supervision.

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
| ~~Meta's pixel over-reports~~ | **Wrong — see § The basis problem.** Shopify only sees a CLICK; it cannot see a view-through, cross-device, an ITP-truncated session, or Amazon at all. Meta-reported CPA is a different denominator, not a worse one. |
| Shopify "Total sales" tile | Includes ~68 renewals/day. Shopify's **conversion rate** is `new checkouts ÷ sessions` and matches our bucketing exactly (3.31% on 8/20 = 10/302). |
| Pre-2025 COGS | Contains ad spend. Never compare raw `total_cogs` % across the 2025 boundary. |

---

## Findings log

### 2026-08-24 (session 1) — "did our own system unoptimize us?"
**Answer: no.** The media-buyer kills were directionally correct. Thu/Fri were the middle of an 8-ad test wave (partly manual); Sat/Sun produced exactly normal weekend volume.

Established: churn shape structural · revenue ⊥ profit · contribution 4.2× · the Nov-2025 retention hit and Mar-2026 AOV hit.

### 2026-08-24 (session 2) — the scale question
Triggered by: *"revenue declines every month, but margin is 22% — does the margin evaporate, or can we cruise?"*

**Answer: neither. Cruising is the one option that isn't available** — holding spend at $41K glides to ~$4K/month profit. Established the scale curve, the December-2024 write-off, and (session 3) the staged Phase 1/Phase 2 ramp with the ceiling derived from marginal CAC rather than a 3× benchmark.

### Corrections (kept so they aren't re-derived)
- ~~"Meta sees ~5% of reality"~~ — compared Meta purchases against *all* orders including renewals.
- ~~"The Amazon halo fails the natural experiment"~~ — drawn from a **5-day window**. Over 19 months `r = 0.78`. The halo is real.
- ~~"Collection rate collapsed to 64%"~~ — put cancelled + paused rows in the denominator of a *collection* rate.
- ~~"m1 retention dropped and stayed down"~~ — recovered to 40%.
- ~~"40% less revenue, 24× the profit"~~ — included the 2024-12 write-off in the regime average. True split is 2.1× profit / 3.5× margin.
- ~~"2025 was unprofitable"~~ — **it made $303K (5.2%), or $396K restated (6.8%).** Only Oct/Nov went negative.
- ~~"Incremental CAC is $230, so accept a smaller business"~~ — wrong metric *and* wrong conclusion. Blended CAC is $55 and the business is under-spending.
- ~~"Meta-reported CPA is ~2x optimistic"~~ — Shopify only sees clicks; it cannot see view-through, cross-device, or Amazon. Meta CPA is a DIFFERENT denominator (~6.4x blended), not a worse one. The thresholds were on the wrong basis, not the signal.
- ~~"~618 customers/month arrive at zero spend"~~ — extrapolated $30K below any observed month; a diminishing-returns fit explains the same data and predicts near-zero. Unknowable without a test.
- ~~"The CAC ceiling is ~$70 (3× LTV:CAC)"~~ — an imported DTC benchmark, not derived. Break-even is **$139** (LTV × contribution margin) and the *marginal* CAC crosses it around **$100K/month**. The $70 rule capped spend at roughly half what the economics support.
- ~~"$150–180K/month is still fine"~~ — read off band AVERAGES. Marginal CAC between $101K and $149K is **$224**, well above break-even.
- ~~Normalizing total COGS across 2024~~ — adds ads-booked-in-COGS back as an accounting error and invents 43% margins.

### 2026-08-24 (session 4) — the stock wrinkle
CEO: Coffee can't be advertised on stock. Investigation found a **bigger** constraint underneath — **FBA is effectively empty (678 net units, zero inbound, ~32 days) while Amazon is 66% of acquisition**. Phase 0 added and Phase 2 gated on it. Also established the **website/Amazon LTV split ($365 / $127)**, which raises the website-only break-even to $242, and confirmed **K-Cups (3,900 website units) as an unconstrained lever**.

### 2026-08-25 — "any way to test the Amazon-trails-spend assumption?"
**Answer: yes, and it holds — at ~12 days, not "a few".** Website peaks at lag 0, Amazon at lag 12,
asymmetric toward spend-leading (the check that rules out shared drift). Slope 2.46 orders/day per
+$1,000/day, 95% CI 1.44–4.79.

**This invalidated the previous day's own conclusion.** The Aug-18 ramp's "$452 marginal CAC" was
measured on day 7 — inside the lag window, before the Amazon response opens. Re-based to ~$173 if the
historical response lands (still above the $139 break-even, but a different decision). Re-measure
Aug 30 – Sep 5. See § The Amazon halo, and the new day-14 rule.

### Shipped
- **#2549** — [[../../dashboard/analytics__profit]] rebuilt on real QuickBooks data ([[../../libraries/profit-estimate]]). Old page reported $46,065 for July against a real $65,458.
- **#2551** — subscription first-order linkage ([[../../libraries/subscription-order-link]]); 1,088 orders backfilled.
- **#2552** — this page.

---

## Open questions

1. **Execute Phase 1 ($41K → $55K), then ramp +15%/month toward ~$100K.** Stop-rule: hold whenever blended CAC crosses **$110**; never exceed **$139**. This is the live decision.
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
| `_amazon-halo.ts` | halo correlation + lags + natural experiments (monthly/weekly — too coarse for the lag; see below) |
| `_amazon-lag-test.ts` | daily-scale cross-correlation w/ website control + circular-shift null + event study |
| `_amazon-lag-timescale.ts` | sweeps smoothing width 1→28d to find the scale the response lives at; reports the minimum detectable effect |
| `_amazon-lag-direction.ts` | **the decisive one** — negative-lag scan; asymmetry separates a causal halo from shared drift |
| `_amazon-lag-magnitude.ts` | slope at peak lag + moving-block bootstrap CI, applied to a live ramp |
| `_budget-audit.ts` | LIVE Meta account → campaign → adset committed daily budget vs the Phase 1 plan |
| `_steady-state.ts` / `_trajectory.ts` | equilibrium revenue and the path to it |
| `_ramp-plan.ts` | Phase 1 sizing + Phase 2 ramp scenarios with the incremental cash cost |
| `_stock-picture.ts` / `_fba-runway.ts` | Phase 0 — sellable units per fulfilment path, FBA runway, ramp impact |
| `_advertisable-mix.ts` / `_kcup-capacity.ts` | acquisition by product vs what we can actually ship |

**Method traps that produced wrong answers:**
- Exclude **2024-12** from correlations (write-off, product COGS 101% of income).
- **Product COGS = `total_cogs` − ads-in-COGS** for any pre-2025 month.
- Dedupe cohorts against a **long lookback** — deduping inside the window counts returning buyers as new (inflated July first-order AOV $102 → $115).
- Control for **day-of-week** on spend-response reads.
- Page every daily-table read past the **1000-row cap**.
- **Inventory lives in `inventory_levels`, not `qb_*_inventory_snapshots`.** The qb_ tables are the accounting rollup; the live Amplifier feed is `inventory_levels` (`location='amplifier_3pl'|'fba'|'shopify'`), columns `on_hand / inbound / reserved`.
- **Never compare a channel's CAC to the BLENDED break-even.** Website LTV $365 vs Amazon $127 — using the $209 blend overstated website-only ramping as 2.8x break-even when it is 1.6x.
- **Never judge a spend change before day 14** — the Amazon response peaks at lag 12. A day-7 read sees the website response only and overstates marginal CAC (it turned $173 into $452).
- **A detrend window can erase the effect you are looking for.** Subtracting a centred 29-day MA makes any response that builds over weeks invisible *by construction*. Sweep the smoothing width before concluding "no effect".
- **A lag correlation is not evidence until it is asymmetric.** Two series that drift together correlate at every lag. Always scan NEGATIVE lags: if orders-lead is as strong as spend-leads, it is shared drift.
- **Always carry a positive control.** Website acquisition must respond at lag 0; if it doesn't, the test is broken, not the hypothesis.
- **Report the minimum detectable effect alongside any null.** "We found nothing" is meaningless without "we could have found X".
- **Never conclude from a <2-week window** — the 5-day Amazon read produced a confidently wrong answer that stood for hours.
- **Never size a ramp from band AVERAGES.** The marginal cost between bands is the decision number; averages understated it by ~2.5x ($89 average vs $224 marginal between $101K and $149K).
- **Never model absolute cash from cohorts alone** — the existing base isn't in them, so an absolute series shows losses where the month actually profited. Model the DELTA vs a do-nothing baseline.

## Related

[[../cfo]] · [[../../libraries/profit-estimate]] · [[../../dashboard/analytics__profit]] · [[../../dashboard/analytics__roas]] · [[../../libraries/acquisition-roas]] · [[../../libraries/blended-cac-ltv]] · [[../../libraries/media-buyer-agent]] · [[../../tables/qb_pnl_snapshots]] · [[../../libraries/order-bucketing]] · [[../../dashboard/analytics__mrr]]

---

[[../../README]] · [[../../../CLAUDE]]
