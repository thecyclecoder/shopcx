-- Meta catalog content_id, decoupled from Shopify.
--
-- The Meta product catalog is currently fed from Shopify, so its items are
-- keyed by the raw numeric Shopify product/variant id (the catalog's
-- retailer_id — e.g. variant 42614446260397). We never want Shopify ids
-- flowing through our own event stream or app code: internally everything is
-- our UUID. So we copy the Shopify id into a dedicated meta_id column that the
-- CAPI dispatcher resolves (UUID -> meta_id) only at the moment it sends events
-- to Meta. When Shopify is sunset, shopify_* ids can be dropped while the Meta
-- catalog (a Meta-side asset that keeps using these same numeric ids) still
-- matches our content_ids — meta_id simply becomes a free-standing identifier.
--
-- Catalog is variant-level (content_type=product), so product_variants.meta_id
-- is the canonical content_id; products.meta_id carries the product-group id.

alter table public.products         add column if not exists meta_id text;
alter table public.product_variants add column if not exists meta_id text;

update public.products
   set meta_id = shopify_product_id
 where meta_id is null and shopify_product_id is not null;

update public.product_variants
   set meta_id = shopify_variant_id
 where meta_id is null and shopify_variant_id is not null;

create index if not exists idx_products_meta_id
  on public.products (workspace_id, meta_id);
create index if not exists idx_product_variants_meta_id
  on public.product_variants (workspace_id, meta_id);
