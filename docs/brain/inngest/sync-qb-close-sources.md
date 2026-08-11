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
| Amazon sales (shipped) | trailing **35 days** | [[../tables/qb_amazon_sales_snapshots]] |
| FBA inventory | **today** | [[../tables/qb_amazon_inventory_snapshots]] |
| 3PL inventory | **today** | [[../tables/qb_tpl_inventory_snapshots]] |
| Processor rollups | **this month + last** | [[../tables/qb_payment_processor_summaries]] |

Runs at 09:30, after the 09:00 logistics FBA/3PL syncs.

## ⭐ Why a daily cron and not something run at close time

**A dated inventory snapshot cannot be reconstructed later.** Inventory APIs report *now* — there is no "what was on hand on the 31st" endpoint. A missed day is a permanently missing period-end physical count, and the close needs the snapshot to land on the actual last day of the month ([[../libraries/qb-close-guard]] blocks on `stale_physical_snapshot`).

Sales, by contrast, are re-synced over a **35-day trailing window** rather than yesterday-only, because refunds and order edits land days after the sale and every sales sync is an idempotent upsert.

## Failure isolation

Each sync runs in its own `step.run` and its failure is collected rather than thrown — an Amplifier outage must not cost the day's FBA snapshot, which is equally unreconstructible. The heartbeat reports `ok: false` when any sync failed, and the return value carries the per-sync `failures[]`.

## Gotchas

- **Amazon sales is a separate SP-API report pull** ([[../libraries/qb-close-sync-amazon-sales]]) — shipped-only, because `daily_amazon_product_snapshots` counts Pending too (July: 803 ordered vs 597 shipped). It is the slowest step: report generation is asynchronous with a 3-minute ceiling.
- **Processors are synced for the PRIOR month too.** Transactions keep settling for days after the sale, so last month's figures move well into the first week of the next. Shoptics' equivalent snapshot froze at 07-31 08:01 UTC and understated July Braintree gross by ~$618 — a month-to-date capture is not a final figure.
- `shopify_payments` currently 403s (ShopCX's token lacks `read_shopify_payments_payouts`). By design that leaves the existing row untouched rather than zeroing it, so the failure is loud but harmless.
- The event form accepts `{start, end}` to re-sync an arbitrary window (a cron firing carries neither).

## Related

[[../libraries/qb-close-sync-sources]] · [[../libraries/qb-close-month-end]] · [[../lifecycles/shoptics-migration]] · [[../functions/cfo]]
