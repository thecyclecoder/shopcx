# Landing Page Scout — per-chapter lander snapshots + gap analysis ⏳

**Owner:** [[../functions/growth]] · **Parent:** [[../goals/acquisition-research-engine]] (M3)
**Blocked-by:** [[competitor-scout]]

Snapshot competitor landing pages **and ours**, mobile, broken into chapters, and vision-analyze the **gaps** → PDP enhancement recommendations that route to Build (new components) or the [[storefront-optimizer]] (experiments).

## Sourcing the competitor landers (the bridge)
- **From [[ad-creative-scout]]'s captured `ecom_advertiser_id`/store domains** — the *exact pages competitors spend to drive paid traffic to* (highest signal; different ads → different landers).
- **+ [[competitor-scout]]'s canonical PDP URLs** for breadth.

## What it does
- **Mobile, per-chapter snapshots** — render at a phone viewport via the headless browser (`scripts/spec-test-browser-check.ts`), scroll to each section, capture per-chapter screenshots (ours uses `StorefrontChapterTracker` anchors → each shot pairs with that chapter's funnel stats: dwell %, CTA rate).
- **Vision gap-analysis** — compare competitor landers vs ours: sections/proof/structure/offers they have that we lack (comparison table, founder story, ingredient breakdown, guarantee badges, …).
- **Enhancement recommendations** — each gap → a recommendation that routes to **Build** (a missing component spec, mirroring the optimizer's missing-tool→build) or the **Optimizer** (a structural experiment). Supervisable: proposes, owner approves.

## Phase 1 — mobile per-chapter snapshotter + vision gap-analysis → recommendations ⏳
Mobile snapshot pipeline (competitor URLs from [[ad-creative-scout]] + [[competitor-scout]], + our own landers), per-chapter capture stored to a private bucket, vision gap-analysis pass, recommendation records that route to Build/optimizer. Brain: [[../goals/acquisition-research-engine]] · [[competitor-scout]] · [[ad-creative-scout]] · [[storefront-optimizer]] · [[../lifecycles/customer-portal]] (chapter tracking) · [[../specs/spec-test-deep-verification]] (headless browser).

## Verification
- For an approved competitor, the scout produces mobile **per-chapter** snapshots of their lander (sourced from the captured ad destination) + our matching lander, stored + viewable.
- The vision pass outputs concrete gaps (*"3 competitors show a comparison table above the fold; we don't"*) → recommendation records routed to Build or the optimizer.
- Our own per-chapter shots pair with that chapter's funnel stats.
- Negative: a competitor lander that fails to load (bot-block) is logged + skipped, not a hard failure; recommendations require owner approval before becoming a Build/experiment.
