# inngest/meta-performance

Meta performance ingestion + variant attribution + scorecards + decision engine for
the Storefront Iteration Engine (Phases 1–4) — mirrors campaign/adset/ad structure +
daily object-grain insights and reconciles against the account rollup (P1), rolls up
per-variant attributed spend + revenue (P2), computes the deterministic daily
scorecards the controller reads (P3), then turns those scorecards + the active policy
into autonomous actions + approval-gated recommendations (P4). Delegates to
[[../libraries/meta__performance]], [[../libraries/meta__attribution]],
[[../libraries/meta__scorecards]], and [[../libraries/meta__decision-engine]].

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
- Calls `refreshVariantAttribution()`; `console.log`s the `variant_attribution_coverage` metric (Phase 5 will route to run-records/alerts). Fires `meta/scorecards-refresh` after attribution lands so Phase 3 stays current.

### `meta-scorecards-refresh` (Phase 3)
- **Trigger:** event `meta/scorecards-refresh`
- **Retries:** 2 · **Concurrency:** `[{ limit: 1, key: "event.data.ad_account_id" }]`
- **Event data:** `{ workspace_id, ad_account_id, snapshot_date?, window_days? }`
- Calls `refreshScorecards()`; `console.log`s the row count + per-level counts + coverage. Idempotent upsert into [[../tables/iteration_scorecards_daily]]. Fires `meta/decision-engine` after scorecards land so Phase 4 stays current.

### `meta-decision-engine` (Phase 4)
- **Trigger:** event `meta/decision-engine`
- **Retries:** 2 · **Concurrency:** `[{ limit: 1, key: "event.data.ad_account_id" }]`
- **Event data:** `{ workspace_id, ad_account_id, snapshot_date? }`
- Calls `runDecisionEngine()` ([[../libraries/meta__decision-engine]]); `console.log`s `policy_active` + autonomous action/escalation counts + recommendations generated/persisted. **4a** autonomous actions are decided + returned (executed in Phase 6a, not here); **4b** recommendations are persisted PAUSED to [[../tables/iteration_recommendations]]. **No external (Meta) writes.** With no active [[../tables/iteration_policies]] version, zero autonomous actions are produced.

## Downstream events sent

- `meta/sync-performance` (from the daily cron)
- `meta/attribution-refresh` (from `meta-sync-performance`, after ingest)
- `meta/scorecards-refresh` (from `meta-attribution-refresh`, after attribution)
- `meta/decision-engine` (from `meta-scorecards-refresh`, after scorecards)

## Tables written

- [[../tables/meta_campaigns]]
- [[../tables/meta_adsets]]
- [[../tables/meta_ads]]
- [[../tables/meta_insights_daily]]
- [[../tables/meta_attribution_daily]] (Phase 2)
- [[../tables/iteration_scorecards_daily]] (Phase 3)
- [[../tables/iteration_recommendations]] (Phase 4b)

## Tables read (not written)

- [[../tables/meta_ad_accounts]]
- [[../tables/meta_connections]]
- [[../tables/daily_meta_ad_spend]] (reconciliation)
- [[../tables/orders]] · [[../tables/storefront_sessions]] · [[../tables/advertorial_pages]] · [[../tables/customers]] (Phase 2 attribution)
- [[../tables/storefront_events]] · [[../tables/product_ad_angles]] · [[../tables/product_benefit_selections]] (Phase 3 scorecards)
- [[../tables/iteration_scorecards_daily]] · `iteration_policies` (Phase 4c, read-only) · [[../tables/meta_adsets]] · [[../tables/meta_campaigns]] (Phase 4 budgets) · [[../tables/product_ad_angles]] · [[../tables/product_benefit_selections]] (Phase 4b grounding)

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
