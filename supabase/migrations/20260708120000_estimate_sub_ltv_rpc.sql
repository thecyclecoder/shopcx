-- Devi re-tool (2026-07-08): kill the 314 GB temp-spill + the biggest internal egress source.
--
-- src/lib/storefront/ltv-proxy.ts estimateSubLTV() used to (1) PAGE THROUGH EVERY subscription in
-- the workspace ordered by created_at (no supporting index → a full on-disk sort of ~28.6K rows on
-- EVERY call → 9 MB temp/call × 35,293 calls = 314 GB, ~98% of all instance temp-spill) and then
-- (2) ship every order for every matched sub AND every order for every matched customer to the app,
-- just to fold ~6 scalars in JS. That is the "size + joins make it expensive" shape → move it into
-- the DB. This RPC returns one aggregate row; the caller keeps only policy (placeholder margin +
-- confidence flags). See docs/brain/libraries/db-health.md (the offender Devi flagged).
--
-- Two DELIBERATELY DIFFERENT refund rules are preserved verbatim from the old JS:
--   • renewal/revenue (sub ⋈ orders): a "paid" order excludes the full REFUNDED set
--     {refunded, REFUNDED, partially_refunded, PARTIALLY_REFUNDED}; NULL status counts as paid.
--   • customer-LTV cross-check (customer-stats parity): excludes ONLY lowercase 'refunded'
--     (partial refunds + NULL still count) — matches getCustomerStatsBatch exactly.

-- GIN index backing the `items @> [{"product_id": …}]` containment filter. jsonb_path_ops is the
-- smaller/faster opclass and supports @> (the only operator we need). All 28.6K rows store items as
-- an array whose elements carry product_id (verified 2026-07-08) — containment is exact + complete.
CREATE INDEX IF NOT EXISTS idx_subscriptions_items_gin
  ON public.subscriptions USING gin (items jsonb_path_ops);

CREATE OR REPLACE FUNCTION public.estimate_sub_ltv(p_workspace_id uuid, p_product_id text)
RETURNS TABLE(
  matched_subs bigint,                -- subs carrying the product (= old subIds.length; drives empty()/flags)
  sampled bigint,                     -- of those, subs with ≥1 paid order (= old `sampled`)
  total_renewals bigint,              -- Σ(paid_orders − 1) over sampled subs
  total_paid_orders bigint,           -- Σ paid_orders over sampled subs
  total_revenue_cents bigint,         -- Σ paid-order total_cents over sampled subs (gross)
  mean_subscriber_ltv_cents bigint    -- customer-links-aware mean realized LTV of matched customers
)
LANGUAGE sql
STABLE
AS $$
  WITH matched AS (
    SELECT s.id, s.customer_id
    FROM public.subscriptions s
    WHERE s.workspace_id = p_workspace_id
      AND s.items @> jsonb_build_array(jsonb_build_object('product_id', p_product_id))
  ),
  -- (1) renewal/revenue: paid orders per matched sub. Refund rule = full REFUNDED set; NULL = paid.
  per_sub AS (
    SELECT o.subscription_id,
           count(*)                       AS n,
           coalesce(sum(o.total_cents), 0) AS rev
    FROM public.orders o
    JOIN matched m ON m.id = o.subscription_id
    WHERE o.financial_status IS NULL
       OR o.financial_status NOT IN ('refunded', 'REFUNDED', 'partially_refunded', 'PARTIALLY_REFUNDED')
    GROUP BY o.subscription_id
  ),
  -- (2) customer-LTV cross-check: expand each matched customer to its customer_links group (or itself),
  --     mirroring getCustomerStatsBatch. Refund rule here = ONLY lowercase 'refunded' excluded.
  matched_customers AS (
    SELECT DISTINCT customer_id FROM matched WHERE customer_id IS NOT NULL
  ),
  cust_expand AS (
    SELECT mc.customer_id AS input_id,
           coalesce(grp.customer_id, mc.customer_id) AS order_customer_id
    FROM matched_customers mc
    LEFT JOIN public.customer_links own ON own.customer_id = mc.customer_id
    LEFT JOIN public.customer_links grp ON grp.group_id = own.group_id
  ),
  cust_ltv AS (
    SELECT ce.input_id,
           coalesce(sum(
             CASE WHEN o.financial_status IS DISTINCT FROM 'refunded'
                  THEN coalesce(o.total_cents, 0) ELSE 0 END
           ), 0) AS ltv
    FROM cust_expand ce
    LEFT JOIN public.orders o ON o.customer_id = ce.order_customer_id
    GROUP BY ce.input_id
  )
  SELECT
    (SELECT count(*) FROM matched)                                   AS matched_subs,
    (SELECT count(*) FROM per_sub)                                   AS sampled,
    (SELECT coalesce(sum(n - 1), 0) FROM per_sub)                    AS total_renewals,
    (SELECT coalesce(sum(n), 0) FROM per_sub)                        AS total_paid_orders,
    (SELECT coalesce(sum(rev), 0) FROM per_sub)                      AS total_revenue_cents,
    (SELECT coalesce(round(avg(ltv)), 0)::bigint FROM cust_ltv)      AS mean_subscriber_ltv_cents;
$$;

COMMENT ON FUNCTION public.estimate_sub_ltv(uuid, text) IS
  'Server-side aggregate for storefront/ltv-proxy estimateSubLTV — replaces a per-product full subscriptions scan + two order-row-shipping joins. Returns one aggregate row; caller applies placeholder margin + flags. See docs/brain/libraries/db-health.md.';
