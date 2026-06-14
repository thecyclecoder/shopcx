-- Performance indexes diagnosed from pg_stat_statements (2026-06-14).
-- The site was "super slow" — NOT resource exhaustion (CPU 7%, conns 58/120),
-- but a few unindexed hot queries doing sequential scans.
--
-- Applied to PROD manually with `CREATE INDEX CONCURRENTLY` (can't run inside a
-- migration transaction). Recorded here as IF NOT EXISTS (no CONCURRENTLY) so
-- fresh/local environments build them and the repo schema stays accurate.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- #1 (user-facing): customers lookups use ILIKE(email) on every checkout / lead
-- / OTP path. The existing (workspace_id, email) btree can't serve a
-- case-insensitive match → seq scans, 0.5–7.6s each. A trigram GIN makes ILIKE
-- index-backed (verified ~4ms via Bitmap Index Scan). btree_gin lets the
-- workspace_id equality ride the same index.
CREATE INDEX IF NOT EXISTS idx_customers_email_trgm
  ON public.customers USING gin (workspace_id, email gin_trgm_ops);

-- #2: orders looked up by `shopify_order_id = ANY(...)` had no supporting index
-- (only shopify_customer_id) → seq scan on the Shopify sync path (26ms × 92k).
CREATE INDEX IF NOT EXISTS idx_orders_shopify_order_id
  ON public.orders (shopify_order_id) WHERE shopify_order_id IS NOT NULL;

-- #3: the agent inbox filters `tags @> (...)` with no GIN on tags, and is polled
-- heavily (925k calls). GIN on (workspace_id, tags) backs the containment check.
CREATE INDEX IF NOT EXISTS idx_tickets_tags_gin
  ON public.tickets USING gin (workspace_id, tags);
