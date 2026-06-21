-- Per-ASIN pack resolution on amazon_asins (Phase 1 of amazon-per-product-sales-attribution).
-- amazon_asins is already the persistent asin↔product home (asin → product_id, current_price_cents);
-- we add the pack layer beside it so Amazon sales become pack-resolvable for per-product AcqROAS.
-- See docs/brain/specs/amazon-per-product-sales-attribution.md + docs/brain/tables/amazon_asins.md.
--
--   pack_size        — 1 | 2, nullable until resolved. The unit a single order line represents.
--   units_per_pack   — servings/pods in the pack (optional, best-effort from title).
--   pack_resolved_by — 'price' | 'order_price' | 'title' | 'manual' — provenance for auditability.

alter table public.amazon_asins
  add column if not exists pack_size smallint,
  add column if not exists units_per_pack int,
  add column if not exists pack_resolved_by text;

-- Seed the validated coffee mapping (grounded 2026-06-21 on live US-marketplace order lines).
-- Pack = price band: 1-pack clusters $80–92, 2-pack $159–184 (~2×). SKU is inconsistent, so NOT used.
-- Idempotent: keyed by the Amazon-global asin; re-running re-asserts the same values.
-- B0BKR169VT had a $0/ambiguous catalog price → resolved off a real $80 order line ('order_price').
update public.amazon_asins set pack_size = 1, pack_resolved_by = 'price'
  where asin in ('B08KYMN52M', 'B0BV4WHWCX', 'B0BLR2B936', 'B0FGHBP2QY') and pack_size is null;
update public.amazon_asins set pack_size = 1, pack_resolved_by = 'order_price'
  where asin = 'B0BKR169VT' and pack_size is null;
update public.amazon_asins set pack_size = 2, pack_resolved_by = 'price'
  where asin in ('B08C47SJ5B', 'B0BV4XY3L7', 'B0BLQRD681') and pack_size is null;
