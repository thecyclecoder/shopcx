# Storefront Optimizer

**Outcome:** a standing **Storefront Optimizer agent** that continuously runs landing-page experiments — starting on **Amazing Coffee** across all four lander types (PDP, listicle, before/after, advertorial) — to grow **predicted lifetime value per visitor**. It's an *employee*: it forms hypotheses, runs campaigns, learns what moves the needle, and reports up. Its **boss is the [[../functions/growth|Growth director]]** (the "Head of Growth" role), which sets its objective + guardrails and **grades every campaign 1–10** (the way the AI analyzer grades tickets); Growth reports to the **[[ceo-mode|CEO]]**. This is the north-star chain ([[../operational-rules]] § North star) made concrete — CEO → role agent → tool — and a real step toward CEO mode.

**Success metric:** landing-page **predicted-LTV-per-visitor**, week over week, per `(product × lander-type × audience)` — plus the agent's **average campaign grade** trending up, and (the truth check) the **4-month actual-LTV reconciler** showing the proxy didn't lie. Owns/contributes to Growth's landing-page-conversion north-star metric.

**Target:** decompose + sequence via the [[../specs/goal-decomposition-engine|goal decomposition engine]] (human-gated) into the milestone specs below, or author them in order. This doc is the seed + the design contract.

## The metric — predicted LTV per visitor (not CVR, not AOV)
Optimizing raw CVR or AOV is a Goodhart loss. The objective is **predicted LTV per visitor** = `(one-time conversions × one-time margin) + (subscription conversions × estimated sub-LTV)`. Sub-LTV ≫ one-time (per the ROAS dashboard), so the agent *naturally* learns to turn visitors into **subscribers**, not just buyers.
- **The 4-month problem (load-bearing):** with monthly renewals, true LTV isn't known for **~4 months**. So **two loops:** a **fast loop** (days–weeks) decides every campaign on the **proxy** `sub-attach-rate × estimated-sub-LTV` at significance; a **slow loop** (~4-month lag) reconciles each past winner's *actual* cohort LTV vs the proxy and **recalibrates** the proxy weights + the lever-importance map (e.g. "discount-heavy offers over-predict LTV — those subs churn"). Until the slow loop has calibrated once, the agent runs **conservatively** (smaller bets, tighter rollback).

## The lever-importance model (the agent's brain)
Hierarchical + **learned**, not static:
- **Chapter level** — ranked from real funnel data we already have (per-chapter dwell + CTA-click share → hero #1, pricing #2).
- **Component level** — decompose a high-value chapter (hero = image · headline · benefit chips · review snippet · trust badges), each seeded with a CRO **prior**.
- **The ranking learns:** each test updates the posterior (a headline variant with 0% CVR delta → demote headline's importance for that product/lander). The agent spends its next tests on the **high-posterior levers**, not by guessing. It's a **two-level bandit** — *which lever to test* × *which variant wins*.
- **Explore/exploit on levers:** importance scores **decay / get re-probed** so a written-off lever can resurrect (a bolder hero may make the headline matter again). The map is per `(product × lander-type × audience)`; learnings tagged product-specific vs general for **cross-product transfer**.

## The campaign loop (the unit of work)
One **campaign** = one hypothesis, one lever (atomic — clean attribution). E.g. *"test a new hero image to lift sub-attach on Amazing Coffee's bare PDP, cold-Meta."* Steps: read the funnel + importance map → form a grounded hypothesis → produce the variant (config edit, or generate a hero via the Nano-Banana hero-gen skill) → stand up a **Thompson-sampling bandit** vs a holdout/control → run to significance (minimize regret) → promote winner / kill loser + **auto-rollback** on an LTV-proxy or refund-spike regression → **commit the learning to memory** (win *or* loss) → receive a **grade**.

## Autonomy (the leash)
- **Autonomous within policy:** copy + hero + (add/remove/reorder) chapter changes on DB-driven landers — reversible, low-risk.
- **Approval-gated:** **offer changes** (and structural rewrites). Offer split: a *first-order* offer → a coupon/discount; an offer that *persists to renewal* → a **dynamic `pricing_rules`** entry (a prerequisite: pricing rules must get more dynamic) — high stakes (bleeds margin on every renewal), so owner-approved.
- **Missing-tool → build-or-request:** if a hypothesis needs a capability that doesn't exist (a video hero, a comparison-table widget, a new review-widget type), the agent **authors a spec → routes it to the build box** (like the repair agent), the component ships, and the **new lever enters its toolbox**. The optimizer *extends* the storefront over time — a compounding system.

## CRO principles it reasons from (+ hard rails)
**Direct response**, **benefit/pain-point over features** ("nobody cares about the product, only what it does for them" — the #1 rule), **hero is the dominant lever**, **pricing-table clarity #2**, **friction reduction**, **ethical urgency/scarcity**, **social proof near the decision**, **message-match** (ad promise = lander headline), **one clear CTA**. **Hard rails:** no disease claims, no fabricated stats, brand voice. (Supplement compliance is non-negotiable.)

## The grade (supervisory loop)
The Growth director **grades each campaign 1–10** (human-overridable), scoring **hypothesis quality separately from result** — a *sound* hypothesis that lost is good learning (high grade); a *lucky* win from a sloppy hypothesis is low. **Initial grade** at significance (proxy + reasoning) + **revised grade ~4 months later** when real LTV lands. Grades **train the agent** (the CEO → Growth → Optimizer feedback loop).

## Foundations we already have (don't rebuild)
- ✅ **Chapter engagement tracking** — `StorefrontChapterTracker` + pixel (`chapter_view`/`dwell`/`scroll_depth`/CTA-click → `storefront_events`), surfaced on `/dashboard/storefront/funnel`.
- ✅ **Hero-image generation** (Nano-Banana Pro skill) · **DB-driven advertorials** (`advertorial_pages` columns) · `storefront_sessions` + Meta CAPI.
- ✅ **The pattern to mirror** — the [[../specs/storefront-iteration-engine|ad iteration engine]] (scorecard → policy → guardrailed execution). The two engines are **two halves of one funnel** and must talk: a winning lander → route more ad spend to it; the ad engine's audiences → which lander/angle to test.

## Decomposition
- **M1 — Storefront experiment + bandit framework:** variant model, assignment, exposure tracking, outcome attribution (incl. the delayed-purchase window), Thompson-sampling stats + holdout/control + auto-rollback. *(The greenfield foundation.)*
  - [[../specs/storefront-experiment-bandit-framework]] ✅ — the on-site experiment substrate: variant model over DB-driven landers, sticky assignment, exposure→outcome attribution across the delayed-purchase window, Thompson sampling + holdout + auto-rollback. *(foundation — builds immediately)*
- **M2 — Lever-importance model + CRO-learnings memory:** hierarchical chapter→component, prior + learned posterior, decay/re-probe, per `(product × lander × audience)`, cross-product transfer. The agent's persistent memory.
  - [[../specs/storefront-lever-importance-memory]] ✅ — hierarchical chapter→component lever map, CRO priors → learned posteriors from experiment outcomes, decay/re-probe, cross-product transfer. *(blocked by M1)*
- **M3 — Predicted-LTV metric + 4-month reconciler:** the proxy (sub-attach × est-LTV from the ROAS dashboard) + the slow actual-LTV calibration loop.
  - [[../specs/storefront-ltv-proxy-reconciler]] ✅ — the fast-loop predicted-LTV-per-visitor proxy (sub-attach × est-sub-LTV + one-time margin) + the slow ~4-month actual-LTV reconciler that recalibrates the proxy. *(foundation — builds immediately)*
- **M3.5 — Activation + scope gate (OFF by default):** [[../specs/storefront-optimizer-activation-gate]] ✅ — the owner/Growth on-switch + enforced product scope (Amazing Coffee). The agent proposes always but runs ZERO live experiments until flipped on. Mirrors the ad engine's policy_active. **Gates M4.**
- **M4 — The Storefront Optimizer agent:** the campaign loop (read funnel + importance → hypothesis → variant via hero-gen/config → bandit campaign → promote/learn), incl. the missing-tool→build routing. Scope: Amazing Coffee × all 4 lander types.
  - [[../specs/storefront-optimizer-agent]] ✅ — the capstone employee agent (new `storefront-optimizer` agent_jobs kind): campaign loop + autonomy-within-policy + missing-tool→build-or-request. *(blocked by M1, M2, M3)*
- **M5 — Head-of-Growth grading loop:** 1–10 grades (hypothesis vs result, initial + 4-month-revised) that train the agent; the Growth-director report contract.
  - [[../specs/storefront-campaign-grading-loop]] ✅ — 1–10 campaign grading (hypothesis quality scored separately from result), initial + 4-month-revised, human-overridable, mirroring the ticket grader; trains the agent. *(blocked by M4)*
- **M6 (gated, when offer levers turn on) — dynamic pricing-rules for persist-to-renewal offers.**
  - [[../specs/storefront-dynamic-renewal-offers]] ⏳ — make `pricing_rules` dynamic/time-boxed for persist-to-renewal offers + wire the optimizer's approval-gated offer lever (margin-floor rail, contributes-to CFO/Retention). *(blocked by M4)*

Owner: [[../functions/growth]] (the boss). Reports to: [[ceo-mode]]. Mirrors: [[../specs/storefront-iteration-engine]] (ads) · [[../specs/repair-agent]] (the build-or-request pattern).
