# `public.inventory_levels` + `public.inventory_snapshots`

**The canonical inventory source of truth** (Logistics). One model for on-hand across every channel/location, replacing the fragmented pair ShopCX had: fresh Shopify JSONB in `products.variants[].inventory_quantity` (hourly sync, Shopify-only) + a stale, backfill-only `product_variants.inventory_quantity` scalar. Neither carried FBA / 3PL / manual; this does. Stores **RAW** quantities as each source reports them — the finished-good rollup with case-pack multipliers lives in the read layer ([[qb_sku_mappings]] `unit_multiplier`), already reconciled.

Migration: `supabase/migrations/20261011160000_inventory_canonical.sql`. Owner: [[../functions/logistics]].

## ⚠️ Which `location` is the truth — Amplifier, not Shopify (CEO, 2026-08-12)

`location='shopify'` is the **BUY GATE** — what the storefront will let a customer purchase. **`location='amplifier_3pl'` is the SHIP TRUTH** — what the 3PL physically holds, and therefore what can actually be fulfilled. **Amplifier is the authority for our inventory.**

The two normally track, so the distinction is invisible until it isn't — and the moment they diverge *is* the out-of-stock incident: Shopify says available → the customer buys → nothing ships. A reader that quotes only the storefront figure cannot see that coming.

| Reader | Location | Keyed by | Use for |
|---|---|---|---|
| [[../libraries/inventory-read]] `getAmplifierOnHandBySku` | `amplifier_3pl` | **SKU** (`sku`/`external_ref`; `variant_id` is null on these rows) | "can we ship it?" — the authority |
| `getShopifyOnHandByVariant` | `shopify` | Shopify variant id | "will the storefront sell it?" — the gate |

`check_inventory` (the orchestrator tool) prefers **Amplifier by SKU**, falls back to Shopify-by-variant for anything the 3PL doesn't carry, and emits an explicit *"sellable, NOT shippable"* warning when the 3PL is at zero while the storefront still shows stock.

**Never read `product_variants.inventory_quantity`.** It is a frozen backfill snapshot. Measured 2026-08-12 it read **3,746** for Mixed Berry (real: 7,779) and **3,748** for Strawberry Lemonade (real: **3**) — wrong for both, in opposite directions, and the 3,746 is the same frozen figure behind incident 9a7f9481.

## `inventory_levels` — current levels (fast read path + single source of truth)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid FK → workspaces | RLS scope |
| `location` | text | `shopify` \| `fba` \| `amplifier_3pl` \| `manual` |
| `external_ref` | text | the channel's native key: ASIN (fba) \| 3PL sku (amplifier_3pl) \| Shopify variant id (shopify) \| manual key |
| `sku` | text? | resolved SKU (nullable until resolved) |
| `product_id` | uuid? FK → products | resolved product (nullable) |
| `variant_id` | text? | Shopify variant id, when applicable |
| `on_hand` | int | fulfillable / available, RAW as the source reports it |
| `inbound` | int | inbound / in-transit (FBA); 0 for sources without it |
| `reserved` | int? | optional (FBA reserved) |
| `source_synced_at` | timestamptz? | when the source last reported this level |
| **unique** | | `(workspace_id, location, external_ref)` — the upsert key |

## `inventory_snapshots` — dated history

Same shape (minus `variant_id`/`reserved`/`source_synced_at`) + `snapshot_date date`, unique `(workspace_id, location, external_ref, snapshot_date)`. Powers the days-of-cover trend + the month-end close inventory audit ([[../lifecycles/shoptics-migration]]).

## Writers

All via `createAdminClient()` (service role); RLS is member-**read** only.

- [`src/lib/inventory/write.ts`](../../../src/lib/inventory/write.ts) `writeInventory(admin, workspaceId, location, rows, snapshotDate)` — upserts `inventory_levels` on the unique key + inserts the dated `inventory_snapshots` row. Every sync goes through this.
- [[../inngest/sync-fba-inventory]] — daily FBA cron (`fetchFbaInventoryByAsin`, paginate + per-ASIN accumulate across seller SKUs).
- [[../inngest/sync-3pl-inventory]] — daily Amplifier cron (`/reports/inventory/current`).
- [[../inngest/sync-inventory]] — hourly Shopify cron; **dual-writes** here (`location='shopify'`) alongside the legacy JSONB mirror until all readers migrate off it.

## Readers

- [`src/lib/logistics/cover.ts`](../../../src/lib/logistics/cover.ts) `computeCover` — on-hand for days-of-cover, **split by fulfillment channel (the pools are NOT fungible):** non-FBA-bound 3PL + manual = **storefront** supply (ships Shopify + internal/subscriber); FBA fulfillable = **Amazon** supply; FBA inbound + `FBA-`prefixed 3PL cases = Amazon *pipeline* only. Rolls raw levels up to finished goods via `qb_sku_mappings` multipliers. See [[../functions/logistics]] § crisis-aware doctrine for why the storefront/Amazon split is load-bearing.

## Gotchas

- **RAW quantities only** — a 2-pack FBA ASIN reports cases, not units; the ×2 multiplier is applied in the read layer, never stored here.
- **Deprecation in flight — `product_variants.inventory_quantity` (stale "Store B") → this table.** Read helper: [`src/lib/inventory/read.ts`](../../../src/lib/inventory/read.ts) `getShopifyOnHandByVariant` (live on-hand keyed by Shopify variant id).
  - ✅ **Done:** the customer-facing AI orchestrator ([`sonnet-orchestrator-v2.ts`](../../../src/lib/sonnet-orchestrator-v2.ts) `getProductKnowledge` + `checkInventory`) now reads canonical, not the stale scalar — this was the real bug (incident 9a7f9481: it read Mixed Berry 3,746 while the truth was 0). The active-crisis OOS override stays as belt-and-suspenders.
  - **Remaining Store-B readers (internal-only, low-harm):** the [`product-variants.ts`](../../../src/lib/product-variants.ts) SDK selects `inventory_quantity` but its consumers (`api/cart`, `cart-gifts`) don't use it; the admin storefront-products page + its variants API display it; `product-intelligence/seed-tools`. Repoint these to `getShopifyOnHandByVariant`.
  - **Then drop the column — GATED on merge.** The drop hits the shared prod DB, so it must land only AFTER this branch merges to `main` (so prod's SDK/API/admin stop selecting the column) AND the canonical `inventory_levels(shopify)` sync is deployed + running (it's dual-written by [[../inngest/sync-inventory]], live only post-deploy). Do NOT author the drop migration in a pre-merge branch — on merge it would break prod-`main` readers that still select the column.
  - `products.variants[].inventory_quantity` (fresh "Store A" JSONB) is the portal's availability source and stays as-is for now (it's fresh); a later phase can point the portal at this table too.

---

[[README]] · [[qb_sku_mappings]] · [[products]] · [[../functions/logistics]] · [[../lifecycles/shoptics-migration]]
