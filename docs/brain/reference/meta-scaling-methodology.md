# Meta ad scaling + fatigue methodology (2025-26)

The definitive media-buying ruleset the [[../specs/media-buyer-test-winner-loop]] operates. Researched 2026-07-07 (Meta official docs + practitioner consensus, debates flagged) and **calibrated to Superfoods' real unit economics**. This is the source of truth for the loop's thresholds — the placeholder floors in early spec drafts (`$50` min-spend) are **wrong for our CPA** and superseded here.

## Thresholds are COMPUTED from live LTV, never baked

The dollar CAC thresholds are **derived each cycle from live LTV**, not hardcoded — so they auto-adapt as retention/AOV move (better retention ⇒ higher LTV ⇒ more CAC headroom; this is how Growth couples to Retention, see [[../libraries/ltv]]). Only the **ratio setpoints** are config, because those ARE the strategy:

- **LTV** recomputed from [[../tables/monthly_revenue_snapshots]] via the ROAS-route formula `LTV = AOV × ((1 − sub_rate) + sub_rate/monthly_churn)` (the number the analytics/ROAS dashboard shows; no product↔ad-account mapping needed — the blended [[../libraries/blended-cac-ltv]] composer returns 0 without mappings, so use the snapshot formula).
- **target CAC = LTV / 3** (the `DEFAULT_BLENDED_CAC_LTV_TARGET` 3:1 setpoint the winner-detector already uses).
- **kill CAC = LTV / 1.5** (1.5:1 floor). Expressing the kill line as a ratio avoids needing a gross-margin input.

**Current snapshot (2026-07-07, illustrative — the loop recomputes):** LTV ≈ **$424** (66% sub rate, 18.3% monthly churn ≈ 5.5-order lifespan, $108 new-customer AOV) ⇒ **target CAC ≈ $141**, **kill CAC ≈ $283**. This matches the founder's lived "$140-150" — because $141 *is* LTV/3.
- **Testing optimizes for PURCHASE** (Option A — [[meta-marketing]] `OFFSITE_CONVERSIONS` → `PURCHASE`). Signal matches the goal; we judge creatives **directionally** on a spend floor + CPA-vs-target, NOT on a 50-purchase statistical bar (unaffordable at $150 CPA — 50 purchases = ~$7,500/creative). Full 50-conversion confidence applies only at the **scaling** stage where budget concentrates.
- **Test audience held constant** = our proven converter (US women 50-65, matches the cold-50+ creative). Broadening to Advantage+ Audience is a *separate* audience experiment, not mixed into creative tests.

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
- Test ad set `120252196709210184` — "MB — Test 01", $50/day, purchase-opt, F50-65 clone, automatic (Advantage+) placements, `LOWEST_COST_WITHOUT_CAP`.
- Scaler = existing `120250561500610184` "Amazing Coffee Grouped Prospecting" (CBO $500/d).

## The numeric ruleset (loop config)

| Rule | Value | Confidence |
|---|---|---|
| **Verdict floor (anti-fluke)** | no decision under **48h AND ~$450 spend** (≈3× our CPA) | practitioner-consensus (3× CPA) |
| **Winner** | CPA ≤ target (~$150, better = better) over ≥~$450 spend, **≥3 purchases** (reject 1-order flukes), held ≥ a few days | our calibration of the generic gate |
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
   - **Never put the MSRP / any $ price on a static** (founder directive). Advertise the offer (free shipping + up to 34% off), not the price.
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
