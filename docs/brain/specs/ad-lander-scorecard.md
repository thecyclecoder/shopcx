# Ad & Lander Quality Scorecard 🚧

**Status:** 🚧 P1 + P2 shipped 2026-06-17 (branch `worktree-ad-lander-scorecard`) · spend/ROAS parked as future roadmap · owner: Dylan · created 2026-06-17

**Shipped surface:** [[../dashboard/storefront__ad-scorecard]] (`/dashboard/storefront/ad-scorecard`) + `GET /api/workspaces/[id]/ad-scorecard`. Verified against live data: 5 Amazing Coffee orders ($353) reconcile across both lenses; results_first is the quality winner (53% engaged, 3 orders) despite fight-aging sending 3.5× the traffic.

**Lifecycle context:** [[../lifecycles/storefront-checkout]] (session/event model), [[../lifecycles/ad-render]] + [[../lifecycles/advertorial-landers]] (creatives + landers), [[../dashboard/storefront__funnel]] (sibling surface).

## Why this matters

Today we can see the **top** of the funnel (Meta reports clicks + its own attributed purchases) and the **bottom** (our `orders`), but the two disagree (Meta credits views/cross-device/modeled; we only see deterministic clicks — see [[../lifecycles/storefront-checkout]] § attribution). The thing neither view gives us is the **middle**: of the traffic an ad actually sent, *how good was it?* Did those visitors engage, add to cart, leave a lead, buy?

Our session data already captures all of that, keyed to the exact creative and lander:

- `storefront_sessions.utm_campaign` = the **ad creative** (it's `ad_campaigns.name` verbatim — confirmed: every published ad tags `utm_campaign=${campaign.name}`).
- `storefront_sessions.utm_content` = the **Meta ad id** (e.g. `120250572897510184`) — true ad-level identity, joinable to `ad_publish_jobs.meta_ad_id`.
- `storefront_sessions.landing_url` = the **lander variant + angle** (`?variant=advertorial&angle=callout-74820d61`, `?variant=reasons&…`, `?variant=beforeafter&…`).

Grouping sessions by these lets us rank **which ad creatives send the most *engaged* traffic** (not just the cheapest clicks) and **which lander variants convert that traffic best** — and feed the winners/losers straight back into the ad builder (which archetype / angle / avatar to scale; which lander to promote). Closes the loop between [[killer-statics]] / [[advertorial-landers]] and real outcomes.

## Data sources (all already exist)

| Source | What it gives the scorecard | Key |
|---|---|---|
| [[../tables/storefront_sessions]] | traffic, channel, creative, lander, internal/bot flags | `utm_campaign`, `utm_content`, `landing_url`, `is_internal`, `is_bot`, `customer_id` |
| [[../tables/storefront_events]] | engagement + intent: `pdp_view`, `pdp_engaged`, `chapter_dwell`, `pack_selected`, `add_to_cart`, `checkout_view`, `order_placed` | `session_id` |
| [[../tables/storefront_leads]] | leads captured (popup signups), per session | `session_id`, `source`, consent timestamps |
| `popup_decisions` | popup shown/engaged/converted, per session | `session_id` |
| [[../tables/orders]] | purchases + revenue (first-touch attributed) | `attributed_utm_campaign`, `attributed_utm_content`, `total_cents` |
| `ad_campaigns` / `ad_publish_jobs` / `advertorial_pages` | enrichment: archetype, angle, avatar, `meta_ad_id`, lander slug | join on name / `meta_ad_id` / angle |

## Metrics per group

**Volume**
- Sessions (excl. internal/bot — reuse the funnel's exclusion).

**Quality of traffic (the new signal)**
- Engaged rate = `pdp_engaged` / sessions.
- Avg chapters dwelled (`chapter_dwell` depth) · scroll/dwell depth.
- Bounce = % single-event sessions.

**Intent**
- ATC rate (`add_to_cart`), pack-select rate, checkout-view rate.

**Leads**
- Lead capture rate = `storefront_leads` (by `session_id`) / sessions.

**Conversion**
- Purchases, revenue, CVR, AOV.

**Composite traffic-quality score** to rank creatives/landers (weights TBD — see open questions).

## Two grouping lenses

1. **Ad creative** — group by `utm_campaign` (= `ad_campaigns.name`), enriched with `utm_content` (Meta ad id → `ad_publish_jobs`) + creative metadata (archetype / angle / avatar). Answers *which ad sends quality visitors*.
2. **Lander variant** — parse `variant` + `angle` from `landing_url`; join `advertorial_pages` by slug/angle. Answers *which lander converts the traffic*. Optional **ad × lander cross-tab** (same ad, different landers) once both lenses exist.

## Attribution model (call out explicitly)

- **Engagement / intent / leads → per-session**, grouped by *that session's* `utm_campaign` / `landing_url`. This is the traffic the ad sent and the lander it saw — correct denominator.
- **Purchases / revenue → `orders.attributed_utm_campaign`** (first-touch), not the converting session's UTM, to avoid undercounting from cross-session / coupon-return (the `?applied=1` SMS-coupon stitch gap — see Dependencies).
- There's a small denominator/numerator window mismatch between the two (session-scoped vs first-touch). Acceptable while single-touch `meta` dominates (95% of recent sessions are `utm_source=meta`); revisit if channels diversify.
- **Exclude `is_internal` / `is_bot`** (e.g. `dylanralston@gmail.com` is an `employee`/internal customer — already correctly dropped by the funnel).
- **Minimum-volume threshold** (e.g. ≥ N sessions) before ranking, with an explicit "not enough data yet" state — small creatives are noise.

## Surface

- New endpoint `/api/workspaces/[id]/ad-scorecard` — reuse the session/event loading + internal/bot exclusion from `src/app/api/workspaces/[id]/storefront-funnel/route.ts` (and its PostgREST 1000-row paging fix).
- Dashboard page/panel under `dashboard/storefront` (sibling to the funnel): sortable table per ad and per lander, date-range picker, min-volume filter.

## Phases

- ✅ **P1 — Ad creative scorecard.** Group by `utm_campaign` + `utm_content`; engaged / ATC / lead / purchase metrics (purchases first-touch via `orders.attributed_utm_campaign`); internal/bot exclusion; min-volume gate; sortable dashboard table; ✦ marks ShopCX-published creatives.
- ✅ **P2 — Lander variant scorecard.** Parse `variant`/`angle` from `landing_url`; join `advertorial_pages` (publication + headline); session-scoped purchases/revenue. _(Ad × lander cross-tab deferred — see open questions.)_
- ⏳ **Feedback loop.** Surface winners/losers back into the ad builder (scale this archetype/angle/avatar; promote this lander).

## Future roadmap (not scheduled)

- 🔭 **Spend / ROAS (was P3).** Pull Meta ad-insights (spend, CPM) via the Marketing API keyed by `meta_ad_id` (= `utm_content`) → cost-per-engaged-visitor, CPA, ROAS. Needs a Meta Marketing API **read** integration we don't have yet (today we publish to Meta but don't pull insights back — see [[../integrations/meta-marketing]]). Deferred until there's appetite; the P1/P2 scorecard stands on its own without it.

## Open questions

- **Quality-score formula + weights** — how to weight engaged rate vs ATC vs lead vs CVR into one rankable number (or keep them as separate sortable columns first).
- **Window mismatch** — accept first-touch purchases against session-scoped denominators, or also compute a session-scoped purchase count for comparison?
- **Lander identity** — rely on `landing_url` params, or persist a resolved `advertorial_page_id` / variant on the session (and/or order, alongside the `product_id` attribution from [[advertorial-landers]]) so it survives URL rewrites?
- **Min-volume threshold value** and how to present sub-threshold rows.
- **Sequencing** — land the coupon-return stitch fix first (below) so purchase attribution is clean before we publish a scorecard people will trust?

## Dependencies / related

- **Coupon-return attribution stitch** (`/api/popup/land`) — anonymous SMS-coupon returns (`?applied=1`) currently land as no-UTM and only recover via first-touch *if* the customer was identified; an anonymous one was lost entirely. Fixing the stitch (tie the return visit to the lead's initial `utm_source=meta` visit) tightens purchase attribution feeding this scorecard. Not a blocker for P1 engagement metrics.
- **Referrer-based channel fallback** — classify no-UTM organic-social / email sessions by `referrer` host instead of "direct"; improves the denominator picture. Not a blocker.
- Relates to [[killer-statics]] (ad archetypes) and [[advertorial-landers]] (lander variants) — this scorecard is their feedback instrument.
