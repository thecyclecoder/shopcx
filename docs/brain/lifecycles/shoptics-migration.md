# Shoptics → ShopCX migration (inventory + month-end close)

**Goal:** absorb Shoptics' working accounting engine — product/account/Amazon mapping + the monthly QuickBooks close — into ShopCX and retire Shoptics, **without changing a single number**. Owners: [[../functions/logistics]] (Marco — mapping/inventory) + [[../functions/cfo]] (Grace — the close + the reconciliation gate).

> **The bar: parallel-run, reconcile to zero.** This is an accounting system, so the migration is a *reconciliation* problem, not a code port. ShopCX runs in **shadow** (computes, posts nothing) and must reproduce Shoptics' actual QBO outputs to **$0.00 variance** across the 4 recorded closes + ≥1 live close, before any cutover. Shoptics is the golden master until the diff is zero. **No QBO writes, no cutover, no Shoptics retirement without the founder.**

## Source system (authoritative map)

Shoptics = Next.js 14 app "logistics" (Supabase ref `ztrjpkestsymbimuqyrz`, `shoptics.ai`). Credentials live in the `integration_credentials` table (jsonb), **not** env vars; QBO tokens in `qb_tokens` (single row `id='current'`, auto-rotating). 32 migrations. Posts to the **same Superfoods QBO realm** ShopCX now reads (`123146094168669`).

### The three mapping systems (crown jewels — port losslessly)

1. **Product mapping** — `sku_mappings(external_id, source∈{amazon,3pl,shopify,manual}, product_id, unit_multiplier, active)`, `UNIQUE(external_id, source)`. Resolver `resolveProductByMapping(externalId, source)` = single active-filtered lookup. Amazon tries **ASIN then seller-SKU**; Shopify accounting keys by **`productId-variantId`** (NOT bare sku — load-bearing); internal orders resolve against source `'3pl'`. Products come FROM QuickBooks (`products.quickbooks_id` unique upsert key; Group items = bundles with BOM). Multi-parent BOM in `product_bom(parent_id, component_id, quantity)` — source of truth over legacy `products.bundle_id`.
2. **Account mapping** — per-product `products.revenue_account_id`; semantic keys in `qb_account_mappings(key PK, qb_id, qb_name)` (catalog = `MAPPING_DEFINITIONS` in `api/qb/account-mappings/route.ts`; hardcoded `DEFAULTS` in `lib/qb-mappings.ts`, realm-specific ids e.g. shrinkage=175); Shopify gateway→processor in `gateway_mappings(gateway_name PK, processor)` (unmapped→`other`); `shipping_protection_products(shopify_product_id PK)` reclassifies revenue→shipping income.
3. **Amazon mapping** — SP-API. Sales via Reports API TSV bucketed by promotion strings (`"FBA Subscribe & Save Discount"`→recurring, `"Subscribe and Save Promotion V2"`→sns_checkout). Margin route uses a **two-hop** resolution: `seller_sku →(external_skus.seller_sku→external_id)→ ASIN →(sku_mappings amazon)→ product` — so `external_skus` is a silent dependency. Fee types: `FBA*`→fbaFees, `Commission`→referralFees, else otherFees.

### The month-end close (8 steps — CLAUDE.md says 7, code is authoritative)

Manual `POST /api/qb/month-end-closing` (no cron). `txnDate` = last day of month (or today with `?debug=true`). Steps 1–2 fatal; 3–8 record-error-and-continue → `completed_with_errors`.

| # | Step | QBO write |
|---|---|---|
| 1 | QB inventory snapshot (pre) | read |
| 2 | Inventory adjustment → shrinkage | `POST inventoryadjustment` (whole-unit `QtyDiff`) |
| 3 | Amazon $0 sales receipt (COGS) | `POST salesreceipt` |
| 4 | Shopify $0 sales receipt (COGS) | `POST salesreceipt` |
| 5 | Internal (shopcx) $0 sales receipt | `POST salesreceipt` (added 2026-06, migr 031/032) |
| 6 | QB inventory snapshot (post) | read |
| 7 | Variance check (QB post vs FBA+3PL+manual) | DB only; pass iff `Σ\|diff\|===0` |
| 8 | sync-processors → Shopify journal entry | `POST journalentry` |

**The 5 golden QBO artifacts per month:** 1 InventoryAdjustment (shrinkage, whole-unit QtyDiffs), up to 3 zero-dollar SalesReceipts (bundles use `GroupLineDetail` so QB auto-expands BOM for COGS; standalone `SalesItemLineDetail` qty/$0), 1 balanced JournalEntry (accrual revenue by `revenue_account_id` + shipping + tax − discounts; per-processor clearing/fees/refunds/chargebacks from `payment_processor_summaries`; internal self-balancing block; rounding plug ≤$1 to `shopify_other_adjustments`; `round2 = round(n*100)/100`).

**Idempotency caveat (critical):** the JournalEntry **is** idempotent (updates in place by stored id + SyncToken). The InventoryAdjustment + SalesReceipts are **not** (no void/dedup) — re-running a `completed_with_errors` month duplicates them. So a real cutover close must be run exactly once per month.

**DB records (golden):** `month_end_closings(closing_month UNIQUE, status, *_id/*_doc for each artifact, variance_check_passed, variance_details)`, `inventory_snapshots(raw_payload.snapshot_type∈{month_end_pre,post}, month)`, `payment_processor_summaries(closing_month, processor, gross_sales, processing_fees, refunds, chargebacks, adjustments, net_deposits)`.

## Integrations to bring over

QBO (OAuth, prod, `?minorversion=65`) — **ShopCX already has its own independent connection** ([[../libraries/quickbooks]]), so no new QBO wiring. Amazon SP-API (LWA), Shopify Admin REST 2024-01 (+ Shopify Payments payouts), PayPal (reporting txns), Braintree (SDK + GraphQL fee CSV, **~58% estimated fees** with an editable override), Amplifier 3PL (HTTP Basic). Runs on **Vercel Cron** (no queue) — in ShopCX these become **Inngest** functions. Shoptics already reads ShopCX's DB for internal orders (`SHOPCX_SUPABASE_URL` in its env) — that bridge inverts once we own it here.

## Golden fixtures (the reconciliation reference)

Captured read-only from the Shoptics DB + live QBO into `fixtures/shoptics-golden/`:
- Mapping/config tables: `products`(59) `product_bom`(37) `sku_mappings`(117) `external_skus`(351) `qb_account_mappings`(21) `gateway_mappings`(9) `shipping_protection_products`(3) `manual_inventory`(20) `kit_mappings`(2).
- Close records: `month_end_closings`(4: 2026-03…06) `payment_processor_summaries`(15).
- **The actual posted QBO entries** per close in `fixtures/shoptics-golden/qbo-entries/{month}.json` — the JournalEntry + SalesReceipts + InventoryAdjustment as QuickBooks returns them. **This is what shadow output must match to the penny.**

## Migration phases + status

- **Phase 0 — Discovery + golden capture.** ✅ This doc + the fixtures.
- **Phase 1 — Port mappings losslessly.** ✅ 8 workspace-scoped `qb_*` tables (migration `20261011140000_qb_close_mappings.sql`) + Shoptics' UUIDs preserved on copy. All 8 reconciled **rowcount + checksum identical** (`qb_items` 59, `qb_item_bom` 37, `qb_sku_mappings` 117, `qb_external_skus` 351, `qb_account_mappings` 21, `qb_gateway_mappings` 9, `qb_shipping_protection_products` 3, `qb_manual_inventory` 20). Re-runnable via `scripts/_copy-qb-mappings.ts` (upsert, idempotent).
- **Phase 2 — Reimplement in shadow.** 🚧 Rebuild the mapping resolvers + the close computations in ShopCX (TS/Inngest), reading the same inputs, **posting nothing**. Two crown-jewel slices are ported + reconciled offline against the golden fixtures:
  - **JE processor-deduction block** (`src/lib/qb-close/journal-entry.ts` · `buildProcessorDeductionLines`) — the per-processor fees→txn-fee-acct / refunds→refunds-acct / chargebacks→chargebacks-acct **Debits** + the clearing-account net-down **Credit**, derived purely from `payment_processor_summaries` + `qb_account_mappings`. **Reconciles to $0.00 vs the actual posted QBO JournalEntry across all 4 golden months** (`scripts/_reconcile-je-processor-lines.ts`). Invariant proven: `clearing_credit = round2(fees+refunds+chargebacks)` per processor; refunds (acct 146) + chargebacks (58) are shared across processors as separate per-processor lines and reconcile in aggregate.
  - **Product / BOM / Amazon resolvers** (`src/lib/qb-close/resolvers.ts`) — `resolveProductByMapping` (active-filtered (external_id, source) lookup), `resolveAmazon` (ASIN-first then seller-SKU), `resolveAmazonSellerSkuTwoHop` (seller_sku → `external_skus` → ASIN → `sku_mappings` → product), `rollUpBomCost` (multi-parent BOM). Ported as **pure functions** (no DB/API → shadow-safe + offline-testable). **All checks pass** (`scripts/_reconcile-resolvers.ts`): round-trips all 117 active mappings, excludes inactive, ASIN-first + two-hop consistent for 29 amazon SKUs, all 37 BOM rows reference real items, 16 bundles roll up (6 fully-costed, 10 incomplete — faithful: those components lack `unit_cost` in the golden data, so Shoptics marks them incomplete too), 2 multi-parent components.
  - **Remaining (needs LIVE inputs → Phase 3):** the JE revenue/deposit/tax/shipping/discount blocks + internal self-balancing + rounding plug, the 3 zero-dollar SalesReceipts, and the InventoryAdjustment all derive from live Shopify/Amazon order data + QB inventory snapshots **not present in the fixtures** (`raw_payload` on the summaries stores only the processor totals). They are reconcilable only against a **live parallel close**, so they wait for Phase 3.
- **Phase 3 — Reconcile to zero.** ⏳ Diff shadow output vs `fixtures/.../qbo-entries` line-by-line for the 4 months + a live parallel close. Golden-master CI tests. Gate: $0 variance, CFO sign-off. The two reconcile harnesses above are the seed of the CI suite.
- **Phase 4/5 — Cutover + retire.** 🛑 HELD FOR FOUNDER. One-writer-at-a-time flip (shadow→system-of-record), Shoptics kept as fallback a full cycle, retire only after a clean live close reconciled + signed off. **No QBO writes until then.**

## Related

[[../functions/logistics]] · [[../functions/cfo]] · [[../libraries/quickbooks]] · [[../tables/qb_pnl_snapshots]] · [[investors-area]]
