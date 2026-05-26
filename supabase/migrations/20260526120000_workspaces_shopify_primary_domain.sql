-- shopify_primary_domain is the customer-facing Shopify domain
-- (e.g. "superfoodscompany.com"). Distinct from:
--   • shopify_domain (the .myshopify slug — "superfoodsco")
--   • storefront_domain (our own first-party storefront — not live yet,
--     and was wrongly serving as the product-URL host for the AI
--     orchestrator, producing pages behind login)
--
-- Used to construct product URLs surfaced to the AI tools so it stops
-- fabricating handles. Bare hostname only — the orchestrator prepends
-- https:// and the /products/{handle} path.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS shopify_primary_domain TEXT;

COMMENT ON COLUMN public.workspaces.shopify_primary_domain IS
  'Customer-facing Shopify domain (host only, no scheme). Source of canonical /products/{handle} URLs surfaced to the AI orchestrator and outbound customer messages.';
