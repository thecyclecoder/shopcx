# qb_tpl_inventory_snapshots

Daily 3PL (Amplifier) inventory per SKU — the warehouse half of "physical on hand" in the month-end audit, and the bulk of total stock. Owner: [[../functions/logistics]] (Marco) / [[../functions/cfo]] (Grace). Read by [[../libraries/qb-close-month-end]].

**Primary key:** `id` · **Unique:** `(workspace_id, sku, snapshot_date)`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · CASCADE |
| `sku` | `text` | NOT NULL · the Amplifier SKU · maps via `qb_sku_mappings` source `3pl` |
| `name` | `text?` | Amplifier's description |
| `quantity_on_hand` | `int` | **physically in the warehouse — use this** |
| `quantity_available` | `int` | `on_hand` minus committed (and a small residual) |
| `quantity_committed` | `int` | allocated to orders not yet shipped |
| `quantity_expected` | `int` | inbound to the 3PL |
| `snapshot_date` | `date` | NOT NULL |

## ⭐ Use `quantity_on_hand`, not `quantity_available`

`available` nets off units **committed** to orders the 3PL has not yet shipped. Those units are still on the shelf and still ours at the cutoff, so excluding them books owned stock as shrinkage.

This was the dominant cause of the July 2026 phantom variance: the excluded bucket held 1,053 units at 6/30 but **2,754 at 7/31**, so every coffee/creamer/tabs SKU read short by 5–10% and the adjustment ballooned. Switching to `on_hand` flipped the whole range from large negatives to small positives (Strawberry Lemonade −467 → +84, Peach Mango −367 → +50).

Note `on_hand ≠ available + committed` exactly for many SKUs — a small residual (often ~10 units) sits outside both. `on_hand` is still the correct physical figure.

## Gotchas

- **Case packs.** `qb_sku_mappings.unit_multiplier` converts a case to units — 3PL multipliers run ×2 through ×36 (e.g. `FBA-B0BJRX45JF` ×36). A raw count is not a unit count.
- **Unmapped SKUs are correctly ignored.** The snapshot carries `WMS-*` (Walmart) and packaging SKUs (`ST-BOX-3`, `AMZ-INSTANT-INSERT`, Uline boxes) — 43,082 raw units at 2026-07-31 across 23 SKUs. These are **not real sellable stock** (CEO 2026-08-11) and must not be counted; only explicitly-mapped SKUs enter the audit.
- The audit selects the latest snapshot **on or before** period end — check `meta.tplSnapshotDate`.
- Some SKUs mirror each other at identical quantities (e.g. `SC-TABS-PM-2` and `WMS-TABS-PM` both 2,255); do not treat these as additive.

## Related

[[qb_amazon_inventory_snapshots]] · [[qb_sku_mappings]] · [[qb_book_inventory_snapshots]] · [[../libraries/qb-close-month-end]]
