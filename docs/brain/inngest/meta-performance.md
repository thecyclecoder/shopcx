# inngest/meta-performance

Meta performance ingestion for the Storefront Iteration Engine (Phase 1) —
mirrors campaign/adset/ad structure + daily object-grain insights, then
reconciles against the account rollup. Delegates to [[../libraries/meta__performance]].

**File:** `src/lib/inngest/meta-performance.ts`

## Functions

### `meta-sync-performance`
- **Trigger:** event `meta/sync-performance`
- **Retries:** 2
- **Concurrency:** `[{ limit: 1, key: "event.data.ad_account_id" }]`
- **Event data:** `{ workspace_id, ad_account_id, meta_account_id, incremental_days? }`
- Calls `ingestMetaPerformance()`; `console.warn`s any reconciliation drift (Phase 5 will route to run-records/alerts).

### `meta-performance-daily`
- **Trigger:** cron `30 11 * * *` (6:30 AM Central — after `meta-daily-sync` account spend rollup)
- **Retries:** 1
- Fans out a `meta/sync-performance` event per active [[../tables/meta_ad_accounts]] row.

## Downstream events sent

- `meta/sync-performance` (from the daily cron)

## Tables written

- [[../tables/meta_campaigns]]
- [[../tables/meta_adsets]]
- [[../tables/meta_ads]]
- [[../tables/meta_insights_daily]]

## Tables read (not written)

- [[../tables/meta_ad_accounts]]
- [[../tables/meta_connections]]
- [[../tables/daily_meta_ad_spend]] (reconciliation)

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
