-- Move product_reviews onto an internal UUID join key
-- ----------------------------------------------------
-- Reviews were originally keyed only by `shopify_product_id` because
-- Klaviyo gives us Shopify IDs, not internal UUIDs. That made every
-- consumer (storefront PDP, portal carousel, link-group review pool)
-- have to translate back through the products table on read.
--
-- We're moving toward a Shopify-independent commerce backend, so any
-- table relating to products should join via the internal UUID. The
-- shopify_product_id column stays put for now — the Klaviyo sync still
-- uses it as the matching key on incoming review payloads — but reads
-- and joins should prefer product_id going forward.

ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES public.products(id) ON DELETE CASCADE;

-- Backfill: match every review row to its products.id via
-- (workspace_id, shopify_product_id). Reviews with no matching product
-- (e.g. archived/deleted Shopify products that left orphaned reviews)
-- stay NULL — the storefront query just won't surface them.
UPDATE public.product_reviews r
SET product_id = p.id
FROM public.products p
WHERE r.workspace_id = p.workspace_id
  AND r.shopify_product_id = p.shopify_product_id
  AND r.product_id IS NULL;

-- Index for the storefront query: load published+featured reviews for
-- a product (or set of products in a link group), ordered by featured
-- first then rating desc.
CREATE INDEX IF NOT EXISTS idx_reviews_product_internal
  ON public.product_reviews(workspace_id, product_id, status, rating DESC);
