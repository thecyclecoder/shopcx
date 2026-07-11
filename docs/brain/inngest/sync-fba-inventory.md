# inngest/sync-fba-inventory

Daily FBA inventory sync. SP-API `getInventorySummaries` → canonical [[../tables/inventory_levels]] (`location='fba'`, keyed by ASIN) + a dated `inventory_snapshots` row, via `writeInventory`. Read-only from Amazon; writes only our own tables (never QuickBooks). Reuses the existing `amazon_connections` auth. Owner: [[../functions/logistics]].

**File:** `src/lib/inngest/sync-fba-inventory.ts` · reader: `src/lib/amazon/fba-inventory.ts` `fetchFbaInventoryByAsin`

**Gotcha:** `spApiRequest` returns a raw `Response` — must `.json()` it. Paginate via `nextToken` and **accumulate per ASIN** (multiple seller SKUs map to one ASIN) — the Shoptics gotcha we re-hit.

## Functions

### `sync-fba-inventory`
- **Trigger:** cron `0 9 * * *` + event `logistics/sync-fba-inventory`
- **Retries:** 1

## Downstream events sent

_None._ Emits a `sync-fba-inventory-cron` [[../libraries/control-tower]] heartbeat (owner `platform`, for loop-liveness monitoring).

## Tables written

- [[../tables/inventory_levels]] (`location='fba'`) + `inventory_snapshots`

## Tables read (not written)

- `amazon_connections`, `amazon_asins`

---

[[../README]] · [[../integrations/amazon]] · [[../functions/logistics]]
