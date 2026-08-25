# inngest/shopify-review-metafields-sync

Daily push of `product_reviews` aggregates into Shopify's `reviews.rating` + `reviews.rating_count` product metafields — the metafields every storefront star and the Google rich-snippet `aggregateRating` read. Took over from the retired Klaviyo Reviews app.

**File:** `src/lib/inngest/shopify-review-metafields-sync.ts`
**Owner:** `cmo` · **Cadence:** daily `0 9 * * *` · **Liveness window:** 30h

## Triggers

- `{ cron: "0 9 * * *" }` — after overnight activity, before US morning traffic
- `{ event: "reviews/shopify-metafields.sync" }` — on demand; `data.workspace_id` scopes to one workspace

## Node completeness

- **Owner** — `cmo` in [[../libraries/control-tower-node-registry]] via the `MONITORED_LOOPS` row
- **Kill switch** — `enforceSwitch("shopify-review-metafields-sync")` as the first body statement; cascades from the `cmo` department row
- **Heartbeat** — `emitCronHeartbeat` at end of run, `ok:false` when any workspace reported an error

## Table writes

None. Reads [[../tables/product_reviews]] + [[../tables/products]]; writes to **Shopify**, not our DB.

## Gotchas

- All the real logic lives in [[../libraries/shopify-review-metafields]] — this file is the schedule + the heartbeat.
- Runs for every workspace with a Shopify token, not just ones with reviews.

## Related

[[../libraries/shopify-review-metafields]] · [[../integrations/klaviyo]] · [[../integrations/shopify]]

---

[[../README]] · [[../../CLAUDE]]
