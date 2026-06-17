# Dashboard · storefront/ad-scorecard

Ranks ad creatives and lander variants by **traffic quality**, not just volume — the feedback instrument for the ad builder ([[../specs/killer-statics|killer-statics]]) and the lander generator ([[../lifecycles/advertorial-landers]]). Answers "which ad sends the most *engaged / add-to-cart / lead / buying* visitors?" and "which lander variant converts that traffic best?"

**Route:** `/dashboard/storefront/ad-scorecard` (sidebar → Storefront → Ad Scorecard)

## Two lenses

1. **Ad creatives** — real sessions grouped by `storefront_sessions.utm_campaign` (= [[../tables/ad_campaigns|ad_campaigns]]`.name`, i.e. one ad). `utm_content` carries the Meta ad id (shown per row). A ✦ marks creatives published through the ShopCX ad tool (a `utm_campaign` that matches an `ad_campaigns` row); everything else was set up directly in Meta Ads Manager.
2. **Lander variants** — sessions grouped by the `variant`/`angle` parsed from `landing_url` (e.g. `?variant=advertorial&angle=callout-74820d61`). Enriched with [[../tables/advertorial_pages|advertorial_pages]] (publication + headline) by joining `angle` → `slug`.

## Metrics (per group)

Cohort denominator = sessions that fired `pdp_view` in the window (the visitors the ad actually delivered to a PDP). Per group: sessions · engaged rate (`pdp_engaged`) · add-to-cart rate · lead rate ([[../tables/storefront_leads]] by `session_id`) · checkout · purchases · revenue · CVR · a composite **quality score** (`cvr×6 + atc×2 + lead×1.5 + engaged×0.4`).

## Attribution model (deliberate)

- **Engagement / ATC / leads** → per-session, on the session's own `utm_campaign` / lander variant (the traffic the ad sent / lander shown).
- **Ad-creative purchases + revenue** → first-touch from [[../tables/orders|orders]]`.attributed_utm_campaign` + `total_cents`, so cross-session / coupon-return sales aren't undercounted (the `?applied=1` SMS-coupon return lands UTM-less; first-touch recovers it for identified customers).
- **Lander purchases + revenue** → session-scoped (`order_placed` event + `meta.total_cents`) because orders don't persist the lander variant.
- **Internal/bot excluded** using the same set as the funnel (`is_internal` / `is_bot` / stitched to an internal customer).
- **Min-volume gate** (selector: 1/5/10/25/50 sessions) hides low-n noise before ranking; hidden-row counts are shown.

## API endpoints called

- `GET /api/workspaces/[id]/ad-scorecard?start=&end=&min=` — returns `{ ads[], landers[], cohort_sessions, min_sessions }`. Reuses the funnel route's internal/bot exclusion, Central-time boundaries, and `fetchAllRows` 1000-row paging.

## Permissions

All workspace members (middleware auth + workspace membership). The API re-checks `workspace_members`.

## Files touched

- `src/app/dashboard/storefront/ad-scorecard/page.tsx` — the page (client component, sortable ad table + lander table)
- `src/app/api/workspaces/[id]/ad-scorecard/route.ts` — the aggregation endpoint
- `src/app/dashboard/sidebar.tsx` — nav entry

## Gotchas

- `utm_campaign` is a **name**, not a key — two creatives sharing a name would merge. Hardening (put `ad_campaigns.id` in `utm_content`) is noted in the spec.
- Lander purchases use session-scoped `order_placed`, so a coupon-return that converts on a UTM-less session attributes to `(default PDP)`, not the original variant. Ad-creative purchases avoid this via first-touch.
- The `(no utm_campaign)` / `(default PDP)` buckets collect organic-social / direct traffic — useful to watch, not an ad/lander.

---

[[../README]] · [[../../CLAUDE]] · spec: [[../specs/ad-lander-scorecard]]
