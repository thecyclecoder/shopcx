# inngest/situation-mine-refresh

The **monthly situation-refresh cron** (customer-situations-all-products Phase 2). Once a month it re-enqueues a `situation-mine` box job for every `is_advertised` product in every workspace that has advertised products, so new reviews (which arrive daily through the in-house review journey) feed new customer situations for the AI shopping agent.

**File:** `src/lib/inngest/situation-mine-refresh.ts` · **Function id:** `situation-mine-refresh-cron`

## Trigger + shape

- **Cron:** `0 6 12 * *` — monthly on the 12th at 06:00 UTC (spaced from the other monthly crons on the 16th/20th). `retries: 1`.
- Fan-out through `enqueueSituationMineForAdvertised` ([[../libraries/situation-miner]]) per workspace. Returns what it **queued**: `{workspaces, products, enqueued, skippedInflight, skippedFresh}` — the box job logs per-run write counts.
- **Idempotent:** `enqueueSituationMine` skips a product with a queued/running job OR mined in the last 7 days — so a cron retry, an overlap with the ship-time backfill, or a product just mined cannot double the box spend.

## Vercel discovers, the box writes

Vercel decides WHAT to refresh; the box (`scripts/builder-worker.ts` → `runSituationMineJob`) reads the best reviews and the deterministic `applySituationMine` ([[../libraries/situation-miner]]) is the only writer — it verifies every quote verbatim + compliance-screens via `checkClaim` before upserting through the [[../libraries/customer-situations]] SDK (`source='mine:<date>'`, never overwriting a `seed:*` row).

## Control-tower (node-completeness trio)

- **OWNER** — `cmo` (the organic-discovery surface is the CMO's mandate).
- **MONITORED_LOOPS** — registered in [[../libraries/control-tower]] `registry.ts` as `situation-mine-refresh-cron`, `kind:'cron'`, `livenessWindowMs: 37 * DAY` (monthly ⇒ 37d per the `MONITOR_TICK_FLOOR_MS` + 1.2× jitter invariant).
- **HEARTBEAT** — `emitCronHeartbeat("situation-mine-refresh-cron", …)` in an end-of-run `step.run`.

## Related

[[../libraries/situation-miner]] · [[../libraries/shopping-agent]] · [[../tables/product_customer_situations]] · [[../lifecycles/ai-shopping-agent]] · [[creative-scout]] (sibling per-product enqueue cron)
