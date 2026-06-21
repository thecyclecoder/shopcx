# Per-ASIN Amazon Sales + Persistent ASIN→Product/Pack Mapping 🚧

**Owner:** [[../functions/growth]] · **Parent:** [[../goals/ceo-mode]] › M2 — Growth Director · realizes Phase 2 of [[../specs/growth-acquisition-roas-spine]]

Make Amazon sales **product- and pack-resolvable** so per-product acquisition ROAS (the Growth agent's KPI) can count the Amazon halo. The data already flows — [[../libraries/amazon__sync-orders]] `processOrderReport` parses `asin`/`item-price`/`quantity` per line and then **discards them**, grouping only by `date|bucket` into [[../tables/daily_amazon_order_snapshots]]. This spec keeps that aggregate intact (the ROAS dashboard reads it unchanged) and adds the per-product layer beside it.

## Grounding (validated read-only, 2026-06-21, US marketplace ATVPDKIKX0DER)
- Pulled a live `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL` report (DONE in ~12s). Order lines carry the catalog ASINs + real `item-price`.
- **Pack = price band** (validated on real order lines, NOT SKU which is inconsistent): 1-pack clusters $80–92, 2-pack $159–184 (~2×). Even a $0-catalog ASIN (B0BV4WHWCX) showed a real $80 order line → 1-pack.
- **Coffee = 32% of Amazon non-renewal** (Jun 7–20). Amazon coffee non-renewal ≈ $5.2k–$6.3k → **coffee AcqROAS ≈ 1.6** vs 0.82 on-site-only.
- [[../tables/amazon_asins]] already maps `asin → product_id` and carries `current_price_cents` (the existing pricing tool) — reuse, don't rebuild.

## Phase 1 — Persistent mapping (extend amazon_asins) 🚧
- **Schema (rides this spec→build):** add to [[../tables/amazon_asins]] `pack_size smallint` (1|2, nullable until resolved) + `units_per_pack int` (servings/pods, optional) + `pack_resolved_by text` ('price'|'order_price'|'title'|'manual') for auditability. NOT on `products` — `amazon_asins` is already the persistent asin↔product home.
- `resolveAsinPack(asin)` resolver: per-product **price bands** from `current_price_cents` (1-pack = base tier, 2-pack ≈ 2× base); fall back to the order line `item-price` (banded) when catalog price is $0, then title servings ('30/24'→1, '60/48/2 Bag Bundle'→2) as last resort. Bands are per-product config, not global.
- Ensure `product_id` set for every Active ASIN (one currently unmapped: B0DK7RJZQY). Seed + commit the validated coffee mapping (8 ASINs above; flag B0BKR169VT for order-price confirmation).
- Brain: update [[../tables/amazon_asins]].

## Phase 2 — Per-product daily snapshot (forward fix) 🚧
- **Schema:** new `daily_amazon_product_snapshots` (workspace_id, amazon_connection_id, snapshot_date, asin, product_id, pack_size, order_bucket, order_count, units, gross_revenue_cents, net_revenue_cents). Unique `(amazon_connection_id, snapshot_date, asin, order_bucket)`.
- Modify `processOrderReport` to ALSO aggregate by `(date, asin, bucket)` and upsert this table — **leave the existing `daily_amazon_order_snapshots` write exactly as-is** so the ROAS dashboard's overall number is untouched.
- **Invariant:** for every (date, bucket), Σ `daily_amazon_product_snapshots.gross_revenue_cents` = `daily_amazon_order_snapshots.gross_revenue_cents` (conservation — unmapped ASINs land under a `product_id=null` row so nothing is lost).
- Brain: new [[../tables/daily_amazon_product_snapshots]]; update [[../libraries/amazon__sync-orders]] + [[../inngest/amazon-sync]].

## Phase 3 — Backfill 🚧
- Re-request `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL` over the historical range in chunks (idempotent upserts, resumable — the [[../../.claude/skills/backfill|backfill]] genre). Populate `daily_amazon_product_snapshots` + resolve any new ASINs' pack via Phase 1.
- Reconcile each backfilled day against the existing aggregate (log drift, never silently truncate).

## Phase 4 — Expose to the AcqROAS metric 🚧
- Per-product non-renewal Amazon revenue (one_time + sns_checkout, recurring excluded) becomes a source for `AcqROAS(product)` in [[../specs/growth-acquisition-roas-spine]]. ROAS dashboard overall number unchanged; a per-product/pack filter is a later add.

## What landed (this build)
- **Migrations** (authored, await apply): `20260621130000_amazon_asins_pack.sql` (adds `pack_size`/`units_per_pack`/`pack_resolved_by` + seeds the 8 validated coffee ASINs) · `20260621130100_daily_amazon_product_snapshots.sql` (new table + unique key + RLS). Apply via `npx tsx scripts/apply-amazon-per-product-migration.ts`.
- **Resolver** `resolveAsinPack` in [[../libraries/amazon__sync-orders]] — per-product price bands → order-line fallback → title.
- **Phase 2** `processOrderReport` now ALSO upserts [[../tables/daily_amazon_product_snapshots]] from the same lines (aggregate write untouched).
- **Phase 3** `scripts/backfill-amazon-product-snapshots.ts` (dry-run default, `--apply`, reconciles drift). Run via `npx tsx scripts/backfill-amazon-product-snapshots.ts --start 2026-06-07 --end 2026-06-21 --apply`.
- **Phase 4** `getAmazonNonRenewalRevenue` in [[../libraries/amazon__per-product-revenue]] — the AcqROAS Amazon source.

## Open questions
- **`B0DK7RJZQY`** is an Active ASIN with no `product_id` and is not in the validated coffee list — the spec doesn't say which product it maps to. Left unmapped (its revenue lands under `product_id=null`, conservation preserved). Needs an owner mapping decision before its Amazon sales attribute to a product line.

## Verification
- [ ] Apply the migration, then `select asin, pack_size, pack_resolved_by from amazon_asins where pack_size is not null` → expect exactly the 8 seeded coffee ASINs (1pk: B08KYMN52M/B0BV4WHWCX/B0BKR169VT/B0BLR2B936/B0FGHBP2QY · 2pk: B08C47SJ5B/B0BV4XY3L7/B0BLQRD681).
- [ ] Run `scripts/backfill-amazon-product-snapshots.ts --start 2026-06-07 --end 2026-06-21 --apply` → expect chunk logs with **no `⚠ drift` lines** (conservation: Σ per-product = aggregate per (date,bucket)).
- [ ] After backfill, sum coffee non-renewal: `getAmazonNonRenewalRevenue({ productIds: <coffee group>, startDate:'2026-06-07', endDate:'2026-06-21' })` → expect grossCents ≈ $5.2k–$6.3k (≈32% of Amazon non-renewal).
- [ ] ROAS dashboard `/analytics/roas` overall ROAS unchanged before/after (still reads `daily_amazon_order_snapshots`, untouched).
- [ ] Next live `amazon/sync-orders` run returns `productSnapshotCount > 0` and writes `daily_amazon_product_snapshots` rows for recent dates.
- [ ] Every new table/library/inngest change has a `docs/brain/` page in the same PR (daily_amazon_product_snapshots, amazon__per-product-revenue, updated amazon__sync-orders + amazon_asins + inngest/amazon-sync).
