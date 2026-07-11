# `public.suppliers` + `public.purchase_order_annotations`

Logistics M2. Durable supply-chain metadata QuickBooks doesn't hold well. Migration: `supabase/migrations/20261012120000_logistics_suppliers_po_annotations.sql`. Owner: [[../functions/logistics]]. SDK: [`src/lib/logistics/suppliers.ts`](../../../src/lib/logistics/suppliers.ts).

## `suppliers`

Who we buy from, classified. **Measured** lead time + fill rate are NOT stored here — they're derived live from QB PO→Bill LinkedTxn ([`lead-times.ts`](../../../src/lib/logistics/lead-times.ts)) and joined by `qb_vendor_id`. This table only annotates that.

| Column | Notes |
|---|---|
| `workspace_id` | RLS scope |
| `name` | unique per workspace |
| `qb_vendor_id` | QuickBooks `Vendor.Id` — join key to measured lead times |
| `kind` | `manufacturer` \| `component` \| `3pl` \| `other` |
| `lead_days_override` | manual lead override (else use the measured avg) |
| `min_order_qty` | MOQ |
| `notes`, `active` | |

Seeded partners (Superfoods): **VitaQuest** (32, finished tabs — long lead ~3-5mo, under-produces), **Gemini Pharmaceuticals** (30393, creamers/coffee/creatine), **NoltPak** (30356, k-cups/pods), **Beyer Graphics** (30, IFC boxes), **Overnight Labels** (30266, gussets/labels), **Amplifier** (30175, 3PL — fulfills storefront, NOT Amazon).

## `purchase_order_annotations`

Our ETA overlay on an open PO — **QB leaves `PurchaseOrder.DueDate` blank**, so the expected-arrival date lives here. Keyed by QB `PurchaseOrder.Id`.

| Column | Notes |
|---|---|
| `qb_po_id` | QuickBooks `PurchaseOrder.Id`, unique per workspace |
| `supplier_id` | FK → suppliers (nullable) |
| `expected_arrival_date` | OUR ETA |
| `eta_status` | `estimated` \| `confirmed` \| `delayed` \| `received` |
| `note` | |

Live example: the Mixed Berry crisis PO `116193` is annotated `2026-07-29 / confirmed` — the measured-lead estimate would say ~June (it's delayed), so the annotation is the truth.

## Readers

- [`replenishment-data.ts`](../../../src/lib/logistics/replenishment-data.ts) `loadReplenishment` resolves each open PO's ETA: **annotation → QB DueDate → measured-lead estimate** (`etaByPo`, with a `source` so the UI marks estimates). `loadSupplierView` joins suppliers to their live measured lead/fill + open POs for the Suppliers page (`/dashboard/logistics/suppliers`).

## Writes

All via `createAdminClient()` (RLS is member-**read** only), through the `suppliers.ts` SDK (`upsertSupplier` / `upsertPoAnnotation`). Read-only from QuickBooks; never writes QBO.

---

[[README]] · [[../functions/logistics]] · [[inventory_levels]] · [[../lifecycles/shoptics-migration]]
