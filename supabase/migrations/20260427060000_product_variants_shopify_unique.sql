-- Convert the partial unique index on (workspace_id, shopify_variant_id) to a
-- non-partial UNIQUE CONSTRAINT so it can be used as an ON CONFLICT target.
-- Postgres' partial unique indexes can't be used with INSERT ... ON CONFLICT
-- without the WHERE clause echoed in the upsert call (which the JS client
-- doesn't support cleanly). Multiple NULLs still coexist because Postgres
-- treats NULL as distinct in unique constraints.
DROP INDEX IF EXISTS public.idx_product_variants_shopify;

ALTER TABLE public.product_variants
  ADD CONSTRAINT product_variants_workspace_shopify_unique
  UNIQUE (workspace_id, shopify_variant_id);
