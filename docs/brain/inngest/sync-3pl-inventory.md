# inngest/sync-3pl-inventory

Daily 3PL inventory sync. Amplifier `/reports/inventory/current` → canonical [[../tables/inventory_levels]] (`location='amplifier_3pl'`, keyed by 3PL SKU) + a dated `inventory_snapshots` row, via `writeInventory`. Raw per-SKU on-hand (`quantity_available`); the finished-good rollup with case-pack multipliers happens in the read layer ([[../tables/qb_sku_mappings]]). Read-only from Amplifier; never writes QuickBooks. Owner: [[../functions/logistics]].

**File:** `src/lib/inngest/sync-3pl-inventory.ts` · reader: `src/lib/integrations/amplifier.ts` `fetchAmplifierInventory` (HTTP Basic `apiKey:''`, creds on `workspaces.amplifier_api_key_encrypted`)

## Functions

### `sync-3pl-inventory`
- **Trigger:** cron `0 9 * * *` + event `logistics/sync-3pl-inventory`
- **Retries:** 1

## Downstream events sent

_None._ Emits a control-tower heartbeat.

## Tables written

- [[../tables/inventory_levels]] (`location='amplifier_3pl'`) + `inventory_snapshots`

## Tables read (not written)

- `workspaces`

---

[[../README]] · [[../integrations/amplifier]] · [[../functions/logistics]]
