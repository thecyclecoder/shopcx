-- Expression index that matches the find_customers_by_phone / find_subscribed_customers_by_phone
-- RPC predicate (migration 20260522140000_phone_lookup_last_10.sql) so STOP/START inbounds from the
-- marketing shortcode (85041) plan as a Bitmap Index Scan on the 620k-row customers table instead
-- of the Seq Scan that hit the statement timeout (Control Tower signature vercel:c1b10ab6583b7104).
--
-- The RPCs compare `right(regexp_replace(customers.phone, '\D', '', 'g'), 10)` against a literal,
-- keyed by workspace_id, with the same two guards on the row (phone not null, ≥10 digits after
-- stripping non-digits). The composite expression index below is a shape-for-shape match — the
-- planner rewrites the WHERE into a single indexed key lookup per workspace and returns in
-- single-digit ms. `idx_customers_phone` still earns its keep for the account-matching exact-string
-- branch (findUnlinkedMatches phone branch), so this is additive, not a replacement.
--
-- Applied to PROD with `CREATE INDEX CONCURRENTLY` (can't run inside a migration transaction);
-- see scripts/apply-customers-phone-last10-index.ts. Recorded here as plain IF NOT EXISTS
-- (no CONCURRENTLY) so fresh/local environments build it and the repo schema stays accurate.

CREATE INDEX IF NOT EXISTS idx_customers_phone_last10
  ON public.customers (workspace_id, right(regexp_replace(phone, '\D', '', 'g'), 10))
  WHERE phone IS NOT NULL
    AND length(regexp_replace(phone, '\D', '', 'g')) >= 10;
