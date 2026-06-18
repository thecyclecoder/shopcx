# Logistics (function)

The permanent owner of **inventory, fulfillment, and suppliers** — stock levels, the 3PL, supplier lead times, stockout avoidance. One of the org-chart functions ([[../goals/ceo-mode]]); this doc is both the **Logistics director-agent's CEO-mode charter** and the **home that owns every Logistics mandate + spec**. A function is never "done" — it carries perpetual mandates and contributes to finite goals.

## Scope + owned metrics

- **Owns:** inventory levels, reorder timing, 3PL/fulfillment, supplier relationships + lead times, stockout/overstock avoidance.
- **North-star metrics:** in-stock rate, days-of-cover by SKU, stockout incidents, landed cost trend.
- **Data we have:** `product_variants.inventory_quantity` + `available`, synced hourly ([[../inngest/sync-inventory]]), readable via `check_inventory` ([[../orchestrator-tools]]); Amplifier for fulfillment.
- **Gaps:** supplier lead times, landed cost (shared with CFO's COGS), an **Amazon** integration (no page yet).

## Mandates (perpetual)

### Inventory & reorder
Never stock out a proven SKU and never tie up cash in overstock — reorder on time within budget.
- **Metric:** in-stock rate, days-of-cover, stockout incidents/month.
- **Specs:** _(none yet — reorder + lead-time work plans under [[../goals/ceo-mode]])._

## Owned / contributed goals

- Contributes to [[../goals/ceo-mode]] › **M1 — Metrics spine + COGS** (landed cost) and **M6 — Close remaining data gaps** (supplier lead times, Amazon).

## Status

Charter doc — planned. First work arrives when the engine plans CEO mode's data-gap milestones (COGS/landed cost, supplier lead times, Amazon).
