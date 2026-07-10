# `src/lib/inngest/ad-creative-cadence.ts`

The daily cron + per-workspace sweep that keeps [[../libraries/media-buyer-agent|Bianca]]'s ready-to-test bin stocked by enqueuing **Dahlia** (the [[../libraries/creative-agent|Ad Creative Agent]]) for every product whose bin has fallen below the floor. Clones the shape of [[media-buyer-cadence]].

## Functions
- **`adCreativeCadenceCron`** (`ad-creative-cadence-cron`, cron `0 11 * * *` UTC — an hour ahead of the 13:00 media-buyer cadence, so fresh creatives are in the bin *before* Bianca's pass). SELECTs distinct `workspace_id` from [[../tables/product_ad_angles]] (a product with ad intelligence) and fans out one `growth/ad-creative-cadence-sweep` event per workspace. Emits an `ad-creative-cadence-cron` [[../libraries/control-tower]] heartbeat (owner `growth`).
- **`adCreativeCadenceSweep`** (event `growth/ad-creative-cadence-sweep`, concurrency-keyed on `workspace_id`) → the pure `dispatchAdCreativeCadence`.

## `dispatchAdCreativeCadence(admin, workspaceId, binFloor?, now?)`
For every intelligence-backed product: computes bin depth (`listReadyToTest` from [[../libraries/ready-to-test]], grouped back to `product_id` via [[../tables/ad_campaigns]]), and for each product below `DEFAULT_BIN_FLOOR` inserts one [[../tables/agent_jobs]] row `kind='ad-creative'` carrying `instructions.product_id` + `instructions.count` (the deficit). The [[../libraries/builder-worker]] `runAdCreativeJob` lane claims it.

**Idempotency:** skips any product already covered by a NOT-YET-TERMINAL `kind='ad-creative'` job created since the current UTC day start (reuses `ACTIVE_MEDIA_BUYER_JOB_STATUSES` + `utcDayStartIso` from [[media-buyer-cadence]]). A same-day re-fire dispatches ZERO new jobs.

Registered in `src/lib/inngest/registered-functions.ts`. See [[../lifecycles/ad-creative]].
