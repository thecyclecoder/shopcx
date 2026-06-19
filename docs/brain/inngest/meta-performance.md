# inngest/meta-performance

Meta performance ingestion + variant attribution for the Storefront Iteration
Engine (Phases 1–2) — mirrors campaign/adset/ad structure + daily object-grain
insights and reconciles against the account rollup (P1), then rolls up per-variant
attributed spend + revenue (P2). Delegates to [[../libraries/meta__performance]]
and [[../libraries/meta__attribution]].

**File:** `src/lib/inngest/meta-performance.ts`

## Functions

### `meta-sync-performance`
- **Trigger:** event `meta/sync-performance`
- **Retries:** 2
- **Concurrency:** `[{ limit: 1, key: "event.data.ad_account_id" }]`
- **Event data:** `{ workspace_id, ad_account_id, meta_account_id, incremental_days? }`
- Calls `ingestMetaPerformance()`; `console.warn`s any reconciliation drift (Phase 5 will route to run-records/alerts). Fires `meta/attribution-refresh` after ingest so Phase 2 stays current.

### `meta-performance-daily`
- **Trigger:** cron `30 11 * * *` (6:30 AM Central — after `meta-daily-sync` account spend rollup)
- **Retries:** 1
- Fans out a `meta/sync-performance` event per active [[../tables/meta_ad_accounts]] row.

### `meta-attribution-refresh` (Phase 2)
- **Trigger:** event `meta/attribution-refresh`
- **Retries:** 2 · **Concurrency:** `[{ limit: 1, key: "event.data.ad_account_id" }]`
- **Event data:** `{ workspace_id, ad_account_id, incremental_days? }`
- Calls `refreshVariantAttribution()`; `console.log`s the `variant_attribution_coverage` metric (Phase 5 will route to run-records/alerts).

## Downstream events sent

- `meta/sync-performance` (from the daily cron)
- `meta/attribution-refresh` (from `meta-sync-performance`, after ingest)

## Tables written

- [[../tables/meta_campaigns]]
- [[../tables/meta_adsets]]
- [[../tables/meta_ads]]
- [[../tables/meta_insights_daily]]
- [[../tables/meta_attribution_daily]] (Phase 2)

## Tables read (not written)

- [[../tables/meta_ad_accounts]]
- [[../tables/meta_connections]]
- [[../tables/daily_meta_ad_spend]] (reconciliation)
- [[../tables/orders]] · [[../tables/storefront_sessions]] · [[../tables/advertorial_pages]] · [[../tables/customers]] (Phase 2 attribution)

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
