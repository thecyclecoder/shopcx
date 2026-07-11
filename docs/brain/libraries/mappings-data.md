# libraries/mappings-data

Read-only loader over the qb_* SKU-resolver tables — powers /dashboard/logistics/mappings.

**File:** `src/lib/logistics/mappings-data.ts`

**Owner:** [[../functions/logistics]] · **Status:** Shipped — [[../specs/logistics-nav-missing-pages]] Phase 4.

## Purpose

The qb_* tables (created in `supabase/migrations/20261012150000_qb_mapping_tables.sql`) are the resolver every logistics read joins on: what external SKU a channel sale came from, which finished-good it burns from, and what its BOM components are. `loadMappings` shapes those four tables into a per-QB-item view for the Mappings page — READ-ONLY (no edit surface here; edits happen through the QB sync + manual admin scripts).

## Exports

**`loadMappings(workspaceId, admin?) → MappingsView`**
- Paginates through `qb_items` + `qb_sku_mappings` + `qb_external_skus` + `qb_item_bom` — four inline `.range()` loops with literal `.from()` table names, matching the pattern in [`src/lib/logistics/cover.ts`](../../../src/lib/logistics/cover.ts) so Turbopack can statically analyze each query. Each read chunks in 1000-row pages because PostgREST silently caps `.select()` at 1000; this is the same load-bearing gotcha called out in [[../functions/logistics]].
- Joins `qb_sku_mappings.external_id + source` → `qb_external_skus` for the title / image / seller_sku display.
- Groups external refs per item by source, resolves BOM components into names via the item catalog, and returns headline counts (`qbItems`, `activeMappings`, `externalSkus`, `bomEdges`).
- Sort: finished-goods first, then bundles, then components, then the rest — alpha within each group.
- All reads via the admin (service-role) client per CLAUDE.md.

**Types:** `MappingsView`, `MappingItemView`, `MappingExternalRef`, `MappingBomComponent`.

## Callers

- [`src/app/dashboard/logistics/mappings/page.tsx`](../../../src/app/dashboard/logistics/mappings/page.tsx) — the sole caller; renders the resolver per QB item as a card with external refs grouped by source + a BOM sub-table.

## See also

- [[../functions/logistics]] — the Logistics function's mandate + doctrine that keys off this resolver.
- [`src/lib/logistics/cover.ts`](../../../src/lib/logistics/cover.ts) `computeCover` — the days-of-cover engine that reads the same qb_* tables to match channel sales → finished-good burn.
- [`src/lib/logistics/replenishment-data.ts`](../../../src/lib/logistics/replenishment-data.ts) `loadReplenishment` — the read layer for the Replenishment / Inventory / Purchase-orders / Lead-times views.
- `supabase/migrations/20261012150000_qb_mapping_tables.sql` — the qb_* creating migration (recomposes the DDL that landed via raw SQL during the shoptics→shopcx migration; RLS + `if not exists` throughout).
