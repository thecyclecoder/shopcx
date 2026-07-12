# `src/lib/inngest/ad-creative-cadence.ts`

The daily cron + per-workspace sweep that keeps [[../libraries/media-buyer-agent|Bianca]]'s ready-to-test bin stocked by enqueuing **Dahlia** (the [[../libraries/creative-agent|Ad Creative Agent]]) for every product whose bin has fallen below the floor. Clones the shape of [[media-buyer-cadence]].

## Functions
- **`adCreativeCadenceCron`** (`ad-creative-cadence-cron`, cron `0 11 * * *` UTC — an hour ahead of the 13:00 media-buyer cadence, so fresh creatives are in the bin *before* Bianca's pass). SELECTs distinct `workspace_id` from [[../tables/product_ad_angles]] (a product with ad intelligence) and fans out one `growth/ad-creative-cadence-sweep` event per workspace. Emits an `ad-creative-cadence-cron` [[../libraries/control-tower]] heartbeat (owner `growth`).
- **`adCreativeCadenceSweep`** (event `growth/ad-creative-cadence-sweep`, concurrency-keyed on `workspace_id`) → the pure `dispatchAdCreativeCadence`.

## `dispatchAdCreativeCadence(admin, workspaceId, binFloor?, now?)`
For every intelligence-backed **advertised** product: computes bin depth (`listReadyToTest` from [[../libraries/ready-to-test]], grouped back to `product_id` via [[../tables/ad_campaigns]]), and for each product below `DEFAULT_BIN_FLOOR` inserts one [[../tables/agent_jobs]] row `kind='ad-creative'` carrying `spec_slug=adCreativeSpecSlug(product_id)` (`ad-creative:<product_id>` — [[../tables/agent_jobs]] `spec_slug` is `NOT NULL`, so an omitted value blocks the insert; Control Tower signature `vercel:731cb5703f5f40b6` on 2026-07-12) + `instructions.product_id` + `instructions.count` (the deficit). The [[../libraries/builder-worker]] `runAdCreativeJob` lane claims it.

**Hero-product advertising gate ([[../libraries/advertised-products]]):** after loading products with `product_ad_angles`, the enumeration intersects with `listAdvertisedProductIds(admin, workspaceId)` — attachment SKUs (Tumbler, Sleep Gummies, Handheld Drink Mixer, Bamboo Coffee Mug) NEVER enter the Dahlia cadence, even when a stray angle row exists for them. Empty gate ⇒ zero dispatches, never a "fall back to all products" default (that was the exact leak Phase 2 closed).

## `adCreativeSpecSlug(productId)`
Deterministic per-product spec slug — `ad-creative:<product_id>`. Keeps `agent_jobs_slug_idx (workspace_id, spec_slug, created_at desc)` useful for the Roadmap rollups and gives each Dahlia job a durable subject on the dashboard. Mirrors [[media-buyer-cadence]] `mediaBuyerSpecSlug`.

**Idempotency:** skips any product already covered by a NOT-YET-TERMINAL `kind='ad-creative'` job created since the current UTC day start (reuses `ACTIVE_MEDIA_BUYER_JOB_STATUSES` + `utcDayStartIso` from [[media-buyer-cadence]]). A same-day re-fire dispatches ZERO new jobs.

Registered in `src/lib/inngest/registered-functions.ts`. See [[../lifecycles/ad-creative]].
