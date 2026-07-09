---
name: ads-analysis
description: Analyze Meta ad-test performance the way the Growth Director (Max) does — pull per-ad insights for an ad account, compute LTV-derived CAC thresholds LIVE, and classify every ad winner/hold/kill/still-testing with the recommended action (promote · retire · refresh). Use for "how are our ads doing / which ads should we kill or scale / check the ad tests / is the coffee account profitable". READ-ONLY analysis — it PROPOSES spend moves; a human/Max/CEO executes them. NOT for creating campaigns/ads (that's direct Meta API work) and NOT the autonomous media-buyer loop (that's media-buyer-test-winner-loop running on the box).
---

# ads-analysis

The read-only reasoning lens for "which ads win, which die." It encodes the exact ruleset in [[../../docs/brain/reference/meta-scaling-methodology.md]] (the source of truth — read it, don't restate its numbers from memory) and applies it to live Meta insights. This is the analysis a founder/Max runs before deciding what to retire or scale. The eventual consumer is the **Growth Director (Max)** ([[../../docs/brain/functions/growth.md]]) — he owns the objective (efficient acquisition); this skill is a bounded proxy he supervises. **North star:** the tool proposes verdicts; the objective-owner disposes. It never mutates ads.

## Run it

```
npx tsx scripts/analyze-ad-tests.ts <accountId> [<accountId> ...] [--ltv=<override>] [--days=30]
```

- No args → both Superfoods accounts: **Amazing Coffee `2352876514967984`** + **Superfood Tabs `196487894712827`**.
- Prints, per account: every spend>0 ad with spend · purchases · CPA · frequency · CTR · **verdict + the one recommended action**, then the account roll-up (blended CPA, an `ACCOUNT UNPROFITABLE` flag when blended CPA > kill line) and the explicit RETIRE / PROMOTE lists.
- Output ends with a reminder that nothing was changed.

Under the hood: `getMetaUserToken` → `metaGraphRequest` (`/act_<id>/insights`, level=ad) for the numbers; `src/lib/ltv.ts` (`getMonthlyChurn` + `blendedLifetimeOrders`) + the latest complete `monthly_revenue_snapshots` row for the live LTV. See [[../../docs/brain/integrations/meta-marketing.md]] · [[../../docs/brain/libraries/ltv.md]].

## The ruleset it applies (from the methodology — thresholds are DERIVED, never hardcoded)

Thresholds recompute from **live LTV** each run so they auto-adapt as retention/AOV move (better retention ⇒ higher LTV ⇒ more CAC headroom — this is how Growth couples to Retention). Only the **ratio setpoints** are config, because those ARE the strategy:

- **LTV** = `AOV × blendedLifetimeOrders(sub_rate, monthly_churn)` from the latest complete monthly snapshot (falls back to the documented figure only if snapshots are thin — the output labels which).
- **target CAC = LTV / 3** · **kill CAC = LTV / 1.5**. (2026-07-09 live run: LTV≈$330 → target≈$110, kill≈$220. The 2026-07-07 doc showed $424/$141/$283 — the drift is the point; trust the live number.)
- **Verdict floor (anti-fluke):** no verdict under **~$450 spend** (≈3× CPA). Below that an ad is `⏳ still testing`, never killed.
- **Winner** = CPA ≤ target over ≥$450 spend and **≥3 purchases** (reject 1-order flukes).
- **Hold** = target < CPA ≤ kill — iterate the hook/creative, do **not** scale.
- **Kill** = CPA > kill, OR ≥$450 spent with <3 purchases (no/flukey conversion).
- **Fatigue (⚠, co-equal signals — never frequency alone; Andromeda hides fatigue from freq):** flagged when frequency ≥4.5 **and** CTR is weak (<1.0). A fatigued winner/hold gets "refresh before scaling," not "scale."

## How to act on the output (proposals → owner disposes)

- **🟢 Winner** → duplicate the creative into the scaler (Advantage+/CBO); scale **+20% max every 3–4 days** while ROAS holds. If ⚠ fatigued, refresh a fresh cut first.
- **🟡 Hold** → keep in-test, iterate hook/creative; don't scale.
- **🔴 Kill** → retire. A whole account flagged `ACCOUNT UNPROFITABLE` (blended CPA > kill) means the prospecting set is bleeding — the priority is new proven-pattern creative (see the methodology's creative-production section: reference-competitor-ad → Nano Banana Pro, real benefits, no MSRP, no fabricated testimonials), not just pruning.
- **⏳ Still testing** → leave running until it clears the $450 floor.

Never let this skill execute a spend move on its own — surface the verdicts and let Max/the CEO approve (a rail hit = escalate, not execute).

## Related

[[../../docs/brain/reference/meta-scaling-methodology.md]] · [[../../docs/brain/functions/growth.md]] · [[../../docs/brain/specs/media-buyer-test-winner-loop.md]] · [[../../docs/brain/integrations/meta-marketing.md]] · [[../../docs/brain/libraries/winning-creative-detect.md]] · [[../../docs/brain/tables/meta_attribution_daily.md]]
