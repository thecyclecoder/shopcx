# Acquisition Research Hub — one surface for sets + findings + gap queue ⏳

**Owner:** [[../functions/growth]] · **Parent:** [[../goals/acquisition-research-engine]] (M4)
**Blocked-by:** [[ad-creative-scout]], [[landing-page-scout]]

House it all together: one dashboard surface where the competitor sets, both scouts' findings, and the gap queue live — and where recommendations route to action.

## What it surfaces
- **Competitor sets** ([[competitor-scout]]) per product — approve/reject proposed competitors here.
- **Ad findings** ([[ad-creative-scout]]) — competitor winning ads (creative + captured copy/spend/longevity) + the ad-gap recommendations.
- **Landing findings** ([[landing-page-scout]]) — competitor vs our lander snapshots (per chapter) + the enhancement-gap recommendations.
- **The gap queue** — every surfaced gap (ad or lander) with its evidence, where the owner (or, later, the Growth director) **approves → routes to Build or the [[storefront-optimizer]]** as an experiment/component. Tracks gap → shipped → won.

## Phase 1 — the hub dashboard + the gap queue + routing ⏳
A `/dashboard/.../acquisition` (owner-only) surface reading the `competitors` table + both scouts' findings; the gap queue with approve→route-to-Build/optimizer actions; gap-throughput stats (proposed → shipped → won). Brain: [[../goals/acquisition-research-engine]] · [[competitor-scout]] · [[ad-creative-scout]] · [[landing-page-scout]] · [[storefront-optimizer]].

## Verification
- The hub shows, per product: the competitor set, the ad findings, the lander findings, and a unified gap queue.
- Approving a gap routes it to Build (a component spec) or the optimizer (an experiment) and tracks it through to shipped/won.
- Gap-throughput metric (the goal's success metric) is visible.
- Negative: non-owner can't access it; an unapproved gap doesn't auto-route.
