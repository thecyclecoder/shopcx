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
| FBA inbound (in transit) | **today** | [[../tables/qb_inbound_shipment_snapshots]] |
| Processor rollups | **this month + last** | [[../tables/qb_payment_processor_summaries]] |

Runs at 09:30, after the 09:00 logistics FBA/3PL syncs.

## ⭐ Why a daily cron and not something run at close time

**A dated inventory snapshot cannot be reconstructed later.** Inventory APIs report *now* — there is no "what was on hand on the 31st" endpoint. The same is true of the **in-transit** position: `shipped − received` collapses to zero the moment Amazon finishes receiving, so a missed day permanently loses it. A missed day is a permanently missing period-end physical count, and the close needs the snapshot to land on the actual last day of the month ([[../libraries/qb-close-guard]] blocks on `stale_physical_snapshot`).

Sales, by contrast, are re-synced over a **35-day trailing window** rather than yesterday-only, because refunds and order edits land days after the sale and every sales sync is an idempotent upsert.

## Failure isolation

Each sync runs in its own `step.run` and its failure is collected rather than thrown — an Amplifier outage must not cost the day's FBA snapshot, which is equally unreconstructible. The heartbeat reports `ok: false` when any sync failed, and the return value carries the per-sync `failures[]`.

## ⭐ Heartbeat shape — zero rows on an unreconstructible sync is NOT a quiet success

The heartbeat `produced` payload carries **both** the summed `rows` **and** a `perSync` map (sub-sync name → row count, summed across workspaces). The single summed count used to hide a sub-sync that collected nothing: in 2026-09 the Amazon-sales sync wrote zero rows for ~30 days while every heartbeat read green, because the healthy total from the other six syncs masked it and `failures` only counts syncs that actually *throw*. A green beat that cannot tell "nothing to do" from "silently collected nothing" is not monitoring.

So the beat is `ok: false` when **either** `failures.length > 0` **or** any sync in `UNRECONSTRUCTIBLE_SYNCS` ran and produced zero rows. `UNRECONSTRUCTIBLE_SYNCS` (exported from `src/lib/inngest/sync-qb-close-sources.ts`) is the three POINT-IN-TIME physical buckets — `fba-inventory`, `tpl-inventory`, `inbound-shipments` — whose data cannot be rebuilt after the fact. The three **sales** syncs are deliberately excluded: they re-sync over a trailing 35-day window, so a legitimately-zero day is possible. A zero-row unreconstructible sync is named in the beat `detail` (as `<sync>:zero-rows`) alongside any thrown failures, so a not-ok morning always states its cause.

## ⭐ Same-day coverage assertion, inline retry, and CEO escalation

Knowing a day was missed is worthless the next morning — Amplifier and Amazon both report NOW, so the position is already gone. The only moment a missing snapshot is recoverable is the day it is missing. So after the sync loop and **before** the heartbeat, the cron runs [[../libraries/qb-close-sync-sources]] `assertSameDayCoverage(admin, ws, today)` per workspace. For each of the three unreconstructible tables (`qb_tpl_inventory_snapshots`, `qb_amazon_inventory_snapshots`, `qb_inbound_shipment_snapshots`) it counts today's rows; if zero it re-runs that table's specific sync **once inline** and re-counts; if still zero it escalates a `dashboard_notifications` card (`type:'system'`, `link:'/dashboard/agents/cfo'`, `metadata.type:'close_snapshot_gap'`, `+ table/date/month_end`) stating plainly the day cannot be recovered later — **one card per (workspace, table, date)**, deduped by the same existence-check as [[daily-order-snapshot]]'s `order_sync_mismatch`. A **month-end** date shouts in the title because that is the case [[../libraries/qb-close-guard]] blocks the close on via `no_physical_snapshot` / `stale_physical_snapshot`. The run return value carries the per-workspace `coverage` breakdown. No new node/kill-switch/heartbeat — this rides the existing `sync-qb-close-sources` cron (owner `cfo`). Regression test: `test:close-snapshot-coverage`.

## Gotchas

- **Amazon sales is a separate SP-API report pull** ([[../libraries/qb-close-sync-amazon-sales]]) — shipped-only, because `daily_amazon_product_snapshots` counts Pending too (July: 803 ordered vs 597 shipped). It is the slowest step: report generation is asynchronous with a 3-minute ceiling, and the 35-day window is pulled as two ≤30-day reports (SP-API caps a report at 30 days — a longer window silently returns no orders).
- **Processors are synced for the PRIOR month too.** Transactions keep settling for days after the sale, so last month's figures move well into the first week of the next. Shoptics' equivalent snapshot froze at 07-31 08:01 UTC and understated July Braintree gross by ~$618 — a month-to-date capture is not a final figure.
- `shopify_payments` currently 403s (ShopCX's token lacks `read_shopify_payments_payouts`). By design that leaves the existing row untouched rather than zeroing it, so the failure is loud but harmless.
- The event form accepts `{start, end}` to re-sync an arbitrary window (a cron firing carries neither).

## Related

[[../libraries/qb-close-sync-sources]] · [[../libraries/qb-close-month-end]] · [[../lifecycles/shoptics-migration]] · [[../functions/cfo]]
