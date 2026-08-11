# sync-qb-close-sources

Daily sync of the month-end close's `qb_*` source tables from ShopCX's own integrations. Owner: [[../functions/cfo]] (Grace). Implements [[../libraries/qb-close-sync-sources]].

| | |
|---|---|
| **Trigger** | cron `30 9 * * *` · event `cfo/sync-qb-close-sources` |
| **Cadence / liveness** | daily · 30h window (registry invariant: daily ⇒ 30h) |
| **Retries** | 2 |
| **Heartbeat** | `emitCronHeartbeat("sync-qb-close-sources", …)` |
| **Owner in registry** | `cfo` (MONITORED_LOOPS) |

## What it does

Per workspace that has `qb_items` (i.e. the mapping layer is ported):

| Sync | Window | Writes |
|---|---|---|
| Shopify sales | trailing **35 days** | [[../tables/qb_shopify_sales_snapshots]] |
| Internal sales | trailing **35 days** | [[../tables/qb_internal_sales_snapshots]] |
| FBA inventory | **today** | [[../tables/qb_amazon_inventory_snapshots]] |
| 3PL inventory | **today** | [[../tables/qb_tpl_inventory_snapshots]] |

Runs at 09:30, after the 09:00 logistics FBA/3PL syncs.

## ⭐ Why a daily cron and not something run at close time

**A dated inventory snapshot cannot be reconstructed later.** Inventory APIs report *now* — there is no "what was on hand on the 31st" endpoint. A missed day is a permanently missing period-end physical count, and the close needs the snapshot to land on the actual last day of the month ([[../libraries/qb-close-guard]] blocks on `stale_physical_snapshot`).

Sales, by contrast, are re-synced over a **35-day trailing window** rather than yesterday-only, because refunds and order edits land days after the sale and every sales sync is an idempotent upsert.

## Failure isolation

Each sync runs in its own `step.run` and its failure is collected rather than thrown — an Amplifier outage must not cost the day's FBA snapshot, which is equally unreconstructible. The heartbeat reports `ok: false` when any sync failed, and the return value carries the per-sync `failures[]`.

## Gotchas

- **Amazon SALES is NOT synced here** — ShopCX's `daily_amazon_product_snapshots` measures a different quantity (July: 803 units vs the close's 597). See [[../libraries/qb-close-sync-sources]].
- Processor rollups ([[../tables/qb_payment_processor_summaries]]) are also not synced yet; the close guard blocks on `missing_processor_summaries` if they're absent.
- The event form accepts `{start, end}` to re-sync an arbitrary window (a cron firing carries neither).

## Related

[[../libraries/qb-close-sync-sources]] · [[../libraries/qb-close-month-end]] · [[../lifecycles/shoptics-migration]] · [[../functions/cfo]]
