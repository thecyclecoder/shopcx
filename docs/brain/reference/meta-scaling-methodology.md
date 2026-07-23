# Meta ad scaling + fatigue methodology (2025-26)

The definitive media-buying ruleset the [[../specs/media-buyer-test-winner-loop]] operates. Researched 2026-07-07 (Meta official docs + practitioner consensus, debates flagged) and **calibrated to Superfoods' real unit economics**. This is the source of truth for the loop's thresholds — the placeholder floors in early spec drafts (`$50` min-spend) are **wrong for our CPA** and superseded here.

## Thresholds are COMPUTED from live LTV, never baked

The dollar CAC thresholds are **derived each cycle from live LTV**, not hardcoded — so they auto-adapt as retention/AOV move (better retention ⇒ higher LTV ⇒ more CAC headroom; this is how Growth couples to Retention, see [[../libraries/ltv]]). Only the **ratio setpoints** are config, because those ARE the strategy:

- **LTV** recomputed from [[../tables/monthly_revenue_snapshots]] via the ROAS-route formula `LTV = AOV × ((1 − sub_rate) + sub_rate/monthly_churn)` (the number the analytics/ROAS dashboard shows; no product↔ad-account mapping needed — the blended [[../libraries/blended-cac-ltv]] composer returns 0 without mappings, so use the snapshot formula).
- **crown / target CAC = $150 (CEO strategic setpoint, Dylan 2026-07-12).** The crown line is a fixed strategy number, NOT `LTV/3` — an ad crowns at CPA ≤ **$150** over ≥ **$450** spend (the verdict floor). Codified as `CROWN_TARGET_CAC` in [[../libraries/ad-insights-sdk]] and as `iteration_policies.crown_max_cpa_cents`/`crown_min_spend_cents` on the live media-buyer loop (already $150/$450). The old `LTV/3` derivation drifted to ≈$110 at current LTV and under-called winners vs the operating rule.
- **kill CAC = LTV / 1.5** (1.5:1 floor). STILL LTV-derived on purpose — retention gains auto-widen the hold band (crown..kill). Expressing the kill line as a ratio avoids needing a gross-margin input.

**Current snapshot (2026-07-12, illustrative — kill recomputes):** LTV ≈ **$330** (64% sub rate, 22.0% monthly churn, $101 new-customer AOV) ⇒ **crown/target CAC = $150 (fixed)**, **kill CAC ≈ $220** (LTV/1.5). The crown number stopped tracking LTV once the CEO pinned it to the lived "$140-150" reality.
- **Testing optimizes for PURCHASE** (Option A — [[meta-marketing]] `OFFSITE_CONVERSIONS` → `PURCHASE`). Signal matches the goal; we judge creatives **directionally** on a spend floor + CPA-vs-target, NOT on a 50-purchase statistical bar (unaffordable at $150 CPA — 50 purchases = ~$7,500/creative). Full 50-conversion confidence applies only at the **scaling** stage where budget concentrates.
- **Test audience held constant** = **broad, no age cap (defaults to 18+), no detailed targeting** — let Meta's algorithm find the buyer inside the broad audience (the creative is the targeting, per the 2025-26 broad-targeting consensus). Exclude existing customers. Narrowing to explicit/aged audiences is a *separate* audience experiment, not mixed into creative tests. (Superseded the old "US women 50-65" narrow test audience — CEO Dylan.)

## Account structure (two campaigns, feeder model)

```
TESTING campaign (ABO)  ──promote winners──▶  SCALING campaign (CBO / Advantage+ Sales)
~15% of budget                                ~85% of budget
one creative-concept per ad set               broad, holds proven winners
purchase-opt, equal ad-set budgets            purchase-opt
```

- **Testing = ABO** (ad-set budgets) so each creative gets equal funded delivery → clean read. Under CBO the algorithm starves variants and you can't tell if the creative or the algorithm killed it.
- **Scaling = CBO / Advantage+ Sales** — let Meta shift spend to the best performers.
- **Consolidate**: 1-3 campaigns total, not 10 fragmented ones. Any ad set that can't clear ~50 events/week gets consolidated (chronic "learning limited" is the #1 avoidable failure).

**Live objects (created 2026-07-07, PAUSED):**
- Testing campaign `120252196683350184` — "MB — Testing (ABO)", `OUTCOME_SALES`, ABO (`is_adset_budget_sharing_enabled=false`).
- Test ad set `120252196709210184` — "MB — Test 01", $50/day, purchase-opt, broad (no age cap, 18+), automatic (Advantage+) placements, `LOWEST_COST_WITHOUT_CAP`.
- Scaler = existing `120250561500610184` "Amazing Coffee Grouped Prospecting" (CBO $500/d).

## Retarget campaign — the THIRD campaign (warm+hot mixed content)

Beyond the two-campaign feeder model (cold TESTING → SCALING), a THIRD standing campaign holds the **warm + hot retargeting audiences** — site visitors, add-to-carts, engagers, and existing-adjacent lists who already know the brand. Because the audiences are warm/hot (not cold-prospecting), the creative is a MIX authored specifically for them (social-proof, offer-reminder, urgency) rather than the cold-50+ hook set the testing rail runs.

Structure choice (2026-11, [[../specs/retarget-campaign-warm-hot-mixed-content]]): **ONE lean consolidated ad set**, not one adset per warm/hot segment. Consolidation is the same "clear ~50 events/week or you're learning-limited" rule from the account-structure section above — a retarget pool is small, so fragmenting it across segment-specific adsets starves each below the delivery floor. Every warm/hot creative Dahlia tags (`audience_temperature` in `{warm,hot}`) publishes into that one consolidated adset.

Supervisable-autonomy rail (own owner + kill-switch + heartbeat, cold rail untouched):
- **Config** lives in [[../tables/media_buyer_retarget_cohorts]] (its own table — distinct from the cold [[../tables/media_buyer_test_cohorts]]): `retarget_meta_campaign_id`, the single `retarget_meta_adset_id`, a `daily_ceiling_cents`, and an `audience_temperatures` whitelist (default `{warm,hot}`).
- **Replenish loop** — [[../libraries/media-buyer-retarget-agent]] `runRetargetReplenishLoopForAccount`, driven daily by [[../inngest/media-buyer-retarget-cadence]]. It reads ready warm/hot creatives ([[../libraries/ready-to-test]] `listReadyToTest` with the temperature whitelist) and publishes passers into the consolidated adset.
- **Publish gate** — [[../libraries/media-buyer-retarget-publish-gate]] `evaluateMediaBuyerRetargetPublish`: single-adset match + ceiling + the SHARED 9/10 Max copy-QC floor (reused verbatim from the cold gate, never re-implemented). A breach publishes PAUSED + escalates (`media_buyer_retarget_publish_refused`).
- **Cold-only invariant preserved** — the retarget rail never reads the cold cohort table and never publishes into a cold adset; Bianca's cold replenish (`temperature: "cold"`) is byte-unchanged.

## The decision tree (CEO Dylan, 2026-07-12 — the media-buyer test-loop verdict bands)

Evaluated each review on the test adset's **cumulative** metrics. Target/crown CAC = **$150**, profit/kill-floor CAC = **$220** (~LTV/1.5), test budget = **$150/day**. All values are configurable `iteration_policies` knobs — [[../libraries/media-buyer-agent]] `detectMetaCpaWinners`/`detectMetaCpaLosers` and [[../libraries/ad-insights-sdk]] `classifyAd` read them; **kill stays fast, only CROWNING is patient.** Deep-research (2026-07-12) refuted the old "$450 / 3-purchase" crown as statistical noise (~3 purchases); consensus is 7+ days AND ~8–10 purchases at/under target.

| Band | Trigger (cumulative) | Action | Knob |
|---|---|---|---|
| **Too early** | spend < ~$150 (day 1) | HOLD — no verdict | — |
| **Fast-kill (dud)** | 0 purchases by **$300** (2× CPA) on bad leading signals; hard backstop 0 purch by **$450** | KILL | `early_trim_min_spend_cents` $300 |
| **Hold / keep-testing** | converting, **CPA ≤ $220**, not yet crown-qualified (CPA $150–220, OR CPA ≤ $150 but < 8 purchases) | HOLD — never trimmed on a leading signal | `hold_band_max_cpa_cents` $220 |
| **Crown → scale** | **CPA ≤ $150 AND spend ≥ $450 AND ≥ 8 purchases** | CROWN → duplicate into the scaler | `crown_max_cpa_cents` $150 · `crown_min_spend_cents` $450 · `crown_min_purchases` 8 |
| **Slow-kill (bleeding)** | converting but **CPA > $220** after ≥ $450 | KILL | `hold_band_max_cpa_cents` |
| **Slow-kill (over-CPA converter)** | converter still at **CPA > $300 after ≥ $600 spend** (CEO 2026-07-15) | KILL — an over-breakeven converter must die at $600, not the $1,200 deadline | `slow_kill_min_spend_cents` $600 · `slow_kill_max_cpa_cents` $300 |
| **Decision deadline** | reaches **$1,200** (~8 test-days) WITHOUT crowning | RETIRE — free the $150/day slot | `max_test_spend_cents` $1,200 |

Worked example (the Superfood Tabs `ingredient-breakdown` ad): at $450 / 3 purchases / $143 CPA it is **HOLD, not a crown** — it must earn 8 purchases (~$1,050–1,200, ~8 days) before we pour scale budget in. A converter at $700 / $160 CPA is **HELD** (profitable, under the $220 floor), not killed. Leading indicators (cost-per-ATC, CTR, thumbstop) **KILL fast, never crown** — the crown signal is CPA + purchase volume only.

| Rule | Value | Confidence |
|---|---|---|
| **Promote** | **duplicate** the winning creative into the scaler (don't disturb the test set) | debated (dup vs raise-in-place); dup preferred |
| **Scale (vertical)** | **+20% max every 3-4 days** while ROAS holds (>20% single edit resets learning) | settled + Meta-official |
| **Scale (horizontal)** | duplicate the winning ad set at **50-70% budget** when a set maxes / CPMs climb | practitioner heuristic |
| **Fatigue (co-equal triggers)** | freq **>3.5** flag / **>4-5** act · OR CTR **down ≥25-30%** vs the creative's own rolling baseline · OR CPA **up ≥20-30% WoW** | directional (freq numbers = one 92-account study) |
| **Refresh** | fresh batch of **3-5+** creatives every **~2-3 weeks** at scale (not single swaps) | consensus |
| **Audience** | broad + Advantage+ Audience for scaling prospecting; exclude existing customers; explicit audiences only for retargeting | settled |

### Learning-phase invariants (Meta-official — the loop must NEVER violate)

Learning phase = until an ad set gathers **~50 optimization events / 7-day window** since the last significant edit. An automated system must:
1. Never change budget **>20% per edit** (>20% = significant edit = learning reset).
2. **Batch** all significant edits into one change (eat one reset, not several).
3. **One** significant edit per ad set per learning window; **never edit an ad set still in learning**.
4. Size every ad set to clear ~50 events/week, or consolidate it.

Significant edits (reset learning): optimization event, targeting, add/remove creative, bid strategy, >20% budget, 7+ day pause, restructure.

## Clear laggards — demote EARLY on leading indicators, but crown SLOWLY (2026-07-09, founder-directed)

The $450 verdict floor is an **anti-fluke guard for a CONFIDENT call** — it does NOT mean you must burn $450 on an obvious laggard. The two directions are **asymmetric**, and conflating them is the expensive mistake:

- **DEMOTE early (defensible, cheap to be wrong):** cut a laggard *before* the floor once it has spent **≥~20% of the floor (~$90+)** AND its **leading indicator is materially worse than the pack**. Our leading indicator is **cost-per-add-to-cart** — ATC is a recognized early purchase-intent signal (Meta's own diagnostic guidance; lower cost-per-ATC → lower CPA), readable *before* purchases accumulate. Practitioner cut-rules: cost-per-result >~30% above the pack, or CPC >2× pack, at ≥20% of threshold. **2026-07-09 coffee test:** skeptic v3 hit **7 ATC @ ~$15 cost-per-ATC vs 1 ATC @ ~$100** for its two siblings on ~$105 each — a ~7× spread, not a fluke → the two siblings were paused. (Tabs' three angles were all 0-ATC on ~$100 → a *null round*, paused entirely and refilled with fresh creative, not "concentrated onto a non-winner.")
- **SCALE only when PROVEN (strict, expensive to be wrong):** a leading ATC signal is enough to **kill a loser** but NOT to **crown a winner**. **Never** build a scale ad set (or a >20% budget jump) until the ad clears the FULL crown — **CPA ≤ $150 at ≥ $450 spend AND ≥ 8 purchases** (the decision-tree crown; ~3 purchases was refuted as noise 2026-07-12). A leading indicator is not a proven winner; it stays *in the test* (HOLD band) until it earns the scale. The scale campaign is for graduates only.

**Why asymmetric:** a false negative (killing a laggard that might've turned around) costs almost nothing — the bench is always refilling. A false positive (scaling a "winner" that regresses after $50) burns real budget. So **cut fast on leading signals, crown slowly on proven ones.**

**Caveats:** high ATC + low purchases can mean checkout/landing friction, not a great creative — sanity-check the funnel before crediting the creative. And the 50-conversion "full confidence" bar (~$5,500/ad at our $110 CPA) is **unaffordable** — we cannot buy statistical certainty; we decide on cost-per-ATC + 3-5 conversions and accept directional calls. Sources: Meta Business Help (cost-per-ATC), AdManage/Flighted/Top Growth (early-cut + 3-5-conversion frameworks), LeadEnforce/Social Media Examiner (scale-without-reset).

## Debates we did NOT paper over

- **Separate ABO test lab vs test-inside-Advantage+/ASC** — unresolved; majority runs a separate ABO lab (our choice). The consolidation-maximalist camp tests inside ASC and lets Meta arbitrate.
- **Promote by duplicate vs raise-in-place** — both credible; we duplicate.
- **ASC is NOT a mandate** — Tinuiti Q1'26 shows Advantage+ Sales *falling* to ~20% of retail spend (from a ~38% peak). Default scaler, not religion.
- **Directional-only numbers**: the freq 3.5/5.0 cliffs and broad-vs-lookalike ROAS splits are single-study; treat as starting points, recalibrate against our own data.
- **Andromeda caveat (2026)**: Meta's algorithm exhausts audiences faster (fatigue in 2-3 wks, not 4-6) and **hides fatigue from frequency** — so CTR-decay + CPA-rise are co-equal signals, never frequency alone.

## Creative production — Amazing Coffee (learned 2026-07-07, founder-verified)

How to make a test static that isn't a guess:

1. **Start from a PROVEN competitor ad, not a blank canvas.** Pull a long-running / cross-brand-repeated winner from [[../tables/creative_skeletons]], then **feed the actual competitor ad image + our real product PNG into Nano Banana Pro** ([[../libraries/gemini]] `generateNanoBananaProCombine`, order `[reference, product]`) and prompt it to *rebuild that ad's layout/typography/energy for Amazing Coffee with our copy*. From-scratch generation looks generic; reference-based matches the winners' design language. (Founder: "go to nano banana pro with the competitor ads, then ask it to make a version for us using our data.")
2. **Lead with the real primary benefits.** Amazing Coffee's lead, customer-confirmed benefits are **Weight Loss** (frame compliantly: "curb cravings / supports metabolism" — never "burns fat/slims waist" or body-shaming) and **Mental Clarity / brain-fog relief**, then energy. NOT generic "all-day clean energy." The **12 superfoods** ingredient story (ingredient→benefit) is itself a major selling point — the ingredient-breakdown archetype is strong.
3. **Verified trust stack (all TRUE — use tastefully, don't crowd):** ★★★★★ · **10,000+ reviews** · **700,000+ customers** · **30-day money-back guarantee** · **3rd-party tested** · **Non-GMO** · **Made in USA** · **Sugar-free** · **"Best Tasting Superfood Coffee" — Gourmet Magazine**.
4. **Hard rules (guardrails):**
   - **Price-on-static rule** (founder directive, 2026-07-10). A **bare MSRP** (e.g. `$79.95`) on a static is a **HARD NO**. Advertise the *offer*, not the sticker price. Exactly **two** price treatments are allowed, both drawn from the [[../libraries/product-intelligence]] SDK's computed `offer`:
     1. **Strikethrough → discounted price + disclaimer** — show `~~$79.95~~ $52.77` (the `discountedUnitCents` at the compounded max) with the disclaimer *"with 3+ units on Subscribe & Save"* (`offer.disclaimer`). Never the strikethrough alone or the MSRP alone.
     2. **Per-serving vs the alternative** — the discounted `perServingCents` (e.g. **~$1.76/cup**) framed against a **$4–8 coffee/latte**. Never MSRP ÷ servings — always the *discounted* price ÷ servings.
     Default (safest) is still to lead with the offer headline (`free shipping + up to 34% off`) and no number at all; the two treatments above are the only ways a number may appear.
   - **Never fabricate a testimonial** — no fake named person, AI face, or fake "verified" checkmark presented as a real customer (FTC + [[../functions/growth]] north-star). A ★ rating is a *product* rating, not attributed to an invented person. First-person ad copy is fine; a fake verified reviewer is not.
   - **Only claims we can back** — no invented guarantees/awards; every trust badge above is real.
   - **Founder QA before spend**: the objective-owner (or CEO) eyeballs every generated creative for garbled text, false claims, and fabrication before it goes live — the generator's self-QA is necessary but not sufficient.
   - Cold-traffic destination baseline = the **Shopify PDP** (`superfoodscompany.com/products/amazing-coffee`), the proven converter; internal landers get tested as *lift vs* that control (Round 2), not as the default.

## Sources

Meta Business Help (learning phase / significant edits) · Motion (creative testing 2025) · Tinuiti Q1'26 benchmark · Jon Loomer / Lebesgue / Conversios (audience) · AdAmigo / Dancing Chicken / TheOptimizer (scaling) · Wittelsbach / Hamza Jameel (fatigue / Andromeda). Full URLs in the 2026-07-07 research run.

## Applying it — the `ads-analysis` skill

This ruleset is operationalized read-only in the **`ads-analysis`** skill (`.claude/skills/ads-analysis/SKILL.md` + `scripts/analyze-ad-tests.ts`). It pulls per-ad Meta insights, computes the LTV-derived thresholds **live** (never hardcoded — `src/lib/ltv.ts`), and classifies every ad winner/hold/kill/still-testing with the recommended action. It PROPOSES; the Growth Director (Max) / CEO disposes — the eventual autonomous consumer is [[../specs/media-buyer-test-winner-loop]] on the box. Run: `npx tsx scripts/analyze-ad-tests.ts` (both accounts) — the founder/Max analysis lens for "which ads to retire or scale."

## Related

[[../specs/media-buyer-test-winner-loop]] · [[../libraries/winning-creative-detect]] · [[../integrations/meta-marketing]] · [[../tables/meta_attribution_daily]] · [[../lifecycles/ad-publish]] · [[../functions/growth]]
