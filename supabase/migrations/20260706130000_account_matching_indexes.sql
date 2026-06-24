-- Account-matching per-branch indexes (docs/brain/specs/account-matching-indexed-split.md).
--
-- findUnlinkedMatches built ONE mixed `.or(and(first_name,last_name),phone.eq,email.ilike)`
-- against the 620k-row customers table. EXPLAIN ANALYZE on prod (workspace fdc11e10…,
-- 619,988 rows) showed a full Seq Scan removing 619,982 rows: the case-insensitive email
-- ILIKE branch is non-indexable on a plain btree and the OR defeats the workspace_id index.
-- Concurrent portal-bootstrap / sonnet / journey-builder calls saturated the pool → PostgREST
-- 500 (Control Tower signature supabase-logs:b5db594131381078).
--
-- The fix splits that OR into per-branch queries; this migration adds the index each branch
-- needs so every branch is a Bitmap Index Scan instead of a Seq Scan:
--   • name  branch → idx_customers_name_match  (workspace_id, first_name, last_name)
--   • phone branch → idx_customers_phone        (workspace_id, phone) WHERE phone IS NOT NULL
--   • email branch → already covered by idx_customers_email_trgm
--                    (gin (workspace_id, email gin_trgm_ops), added 2026-06-14).
--
-- Applied to PROD with `CREATE INDEX CONCURRENTLY` (can't run inside a migration transaction);
-- see scripts/apply-account-matching-indexes-migration.ts. Recorded here as plain
-- IF NOT EXISTS (no CONCURRENTLY) so fresh/local environments build them and the repo schema
-- stays accurate.

-- name branch: and(first_name.eq.X, last_name.eq.Y) scoped to a workspace.
CREATE INDEX IF NOT EXISTS idx_customers_name_match
  ON public.customers (workspace_id, first_name, last_name)
  WHERE first_name IS NOT NULL AND last_name IS NOT NULL;

-- phone branch: phone.eq.X scoped to a workspace. Partial keeps it small — most match
-- lookups carry a phone, but a large share of rows have none.
CREATE INDEX IF NOT EXISTS idx_customers_phone
  ON public.customers (workspace_id, phone)
  WHERE phone IS NOT NULL;
