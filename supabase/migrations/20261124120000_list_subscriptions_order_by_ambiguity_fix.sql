-- Fix: ambiguous column reference in public.list_subscriptions ORDER BY.
--
-- The paged CTE's ORDER BY referenced bare `next_billing_date`, `created_at`,
-- and `status`. In a plpgsql function those names also exist as the
-- RETURNS TABLE OUT parameters, so Postgres raises
-- 'column reference "next_billing_date" is ambiguous' for the default sort
-- path (and every sort option), breaking the subscriptions dashboard list for
-- any workspace that hits it.
--
-- Minimal, behavior-preserving fix: alias the paged CTE's source as
-- `recovery_filtered rf` and qualify each ORDER BY CASE branch against that
-- alias (rf.next_billing_date / rf.created_at / rf.status) so the references
-- bind unambiguously to the CTE column, not the OUT parameter. Everything else
-- (signature, filters, window count, GRANT, COMMENT) is unchanged from
-- supabase/migrations/20261005140000_list_subscriptions_rpc.sql.

-- Drop first: CREATE OR REPLACE FUNCTION cannot change the return signature
-- so any later redefinition must drop before re-creating.
DROP FUNCTION IF EXISTS public.list_subscriptions(uuid, text, text, text, text, text[], text, text, int, int);

CREATE OR REPLACE FUNCTION public.list_subscriptions(
  p_workspace uuid,
  p_status text,                -- 'active' | 'paused' | 'cancelled' | 'expired' | NULL/'all'
  p_payment text,               -- 'succeeded' | 'failed' | 'skipped' | NULL/'all'
  p_recovery text,              -- 'in_recovery' | 'recovered' | 'failed' | NULL/'all'
  p_search text,                -- ilike over customers.email / first_name / last_name; NULL/'' = no search
  p_product_ids text[],         -- items @> [{"product_id": id}] for ANY id; NULL/'{}' = no product filter
  p_sort text,                  -- 'next_billing_date' | 'created_at' | 'status'
  p_order text,                 -- 'asc' | 'desc'
  p_limit int,
  p_offset int
)
RETURNS TABLE(
  total_count bigint,
  id uuid,
  shopify_contract_id text,
  shopify_customer_id text,
  status text,
  items jsonb,
  billing_interval text,
  billing_interval_count int,
  next_billing_date timestamptz,
  last_payment_status text,
  delivery_price_cents bigint,
  created_at timestamptz,
  updated_at timestamptz,
  customer_id uuid,
  customer_email text,
  customer_first_name text,
  customer_last_name text,
  recovery_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sort text := lower(coalesce(p_sort, 'next_billing_date'));
  v_asc  boolean := (lower(coalesce(p_order, 'asc')) <> 'desc');
  v_search text := nullif(trim(coalesce(p_search, '')), '');
  v_search_pat text := CASE WHEN v_search IS NULL THEN NULL ELSE '%' || v_search || '%' END;
  v_status text := nullif(coalesce(p_status, ''), '');
  v_payment text := nullif(coalesce(p_payment, ''), '');
  v_recovery text := nullif(coalesce(p_recovery, ''), '');
  v_product_filter boolean := (p_product_ids IS NOT NULL AND array_length(p_product_ids, 1) IS NOT NULL);
  v_product_json jsonb;
  v_recovered_since timestamptz := now() - interval '7 days';
BEGIN
  IF v_sort NOT IN ('next_billing_date', 'created_at', 'status') THEN
    v_sort := 'next_billing_date';
  END IF;

  IF v_status = 'all' THEN v_status := NULL; END IF;
  IF v_payment = 'all' THEN v_payment := NULL; END IF;
  IF v_recovery = 'all' THEN v_recovery := NULL; END IF;

  IF v_product_filter THEN
    -- Build the array of containment shapes: items @> ANY(v_product_json)
    -- where each element is `[{"product_id":<id>}]`. jsonb ?| would also work
    -- against a `product_ids` key that doesn't exist here; the elements carry
    -- product_id, so the shape must be array-containment.
    SELECT jsonb_agg(jsonb_build_array(jsonb_build_object('product_id', pid)))
      INTO v_product_json
      FROM unnest(p_product_ids) AS pid
      WHERE pid IS NOT NULL AND pid <> '';
    IF v_product_json IS NULL OR jsonb_array_length(v_product_json) = 0 THEN
      v_product_filter := false;
    END IF;
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT
      s.id,
      s.shopify_contract_id,
      s.shopify_customer_id,
      s.status,
      s.items,
      s.billing_interval,
      s.billing_interval_count,
      s.next_billing_date,
      s.last_payment_status,
      s.delivery_price_cents,
      s.created_at,
      s.updated_at,
      s.customer_id,
      c.email        AS customer_email,
      c.first_name   AS customer_first_name,
      c.last_name    AS customer_last_name,
      -- Latest dunning cycle per contract (highest cycle_number). Derived here
      -- so the recovery filter can bind against it BEFORE pagination.
      latest_dc.status        AS latest_dunning_status,
      latest_dc.recovered_at  AS latest_dunning_recovered_at
    FROM public.subscriptions s
    INNER JOIN public.customers c ON c.id = s.customer_id
    LEFT JOIN LATERAL (
      SELECT d.status, d.recovered_at
      FROM public.dunning_cycles d
      WHERE d.workspace_id = s.workspace_id
        AND d.shopify_contract_id = s.shopify_contract_id
      ORDER BY d.cycle_number DESC
      LIMIT 1
    ) latest_dc ON true
    WHERE s.workspace_id = p_workspace
      AND (v_status IS NULL OR s.status = v_status)
      AND (v_payment IS NULL OR s.last_payment_status = v_payment)
      AND (
        v_search_pat IS NULL
        OR c.email ILIKE v_search_pat
        OR c.first_name ILIKE v_search_pat
        OR c.last_name ILIKE v_search_pat
      )
      AND (
        NOT v_product_filter
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_product_json) AS q(shape)
          WHERE s.items @> q.shape
        )
      )
  ),
  annotated AS (
    SELECT
      f.*,
      CASE
        WHEN f.latest_dunning_status IN ('active', 'skipped') THEN 'in_recovery'
        WHEN f.latest_dunning_status IN ('paused', 'exhausted') THEN 'failed'
        WHEN f.latest_dunning_status = 'recovered'
          AND f.latest_dunning_recovered_at IS NOT NULL
          AND f.latest_dunning_recovered_at >= v_recovered_since
          THEN 'recovered'
        ELSE NULL
      END AS recovery_status
    FROM filtered f
  ),
  recovery_filtered AS (
    SELECT *
    FROM annotated a
    WHERE v_recovery IS NULL OR a.recovery_status = v_recovery
  ),
  paged AS (
    SELECT
      rf.*,
      count(*) OVER () AS total_count
    FROM recovery_filtered rf
    ORDER BY
      -- Ordering is dispatched by the resolved sort column. Two branches per
      -- direction because ORDER BY CASE + dynamic ASC/DESC on timestamptz +
      -- text can't share a single expression cleanly. Columns are qualified
      -- against the recovery_filtered alias (rf) so they bind to the CTE
      -- columns and not the same-named RETURNS TABLE OUT parameters, which
      -- would otherwise raise 'column reference is ambiguous'.
      CASE WHEN v_sort = 'next_billing_date' AND v_asc     THEN rf.next_billing_date END ASC NULLS LAST,
      CASE WHEN v_sort = 'next_billing_date' AND NOT v_asc THEN rf.next_billing_date END DESC NULLS LAST,
      CASE WHEN v_sort = 'created_at'        AND v_asc     THEN rf.created_at END ASC NULLS LAST,
      CASE WHEN v_sort = 'created_at'        AND NOT v_asc THEN rf.created_at END DESC NULLS LAST,
      CASE WHEN v_sort = 'status'            AND v_asc     THEN rf.status END ASC NULLS LAST,
      CASE WHEN v_sort = 'status'            AND NOT v_asc THEN rf.status END DESC NULLS LAST,
      rf.id ASC
    LIMIT p_limit
    OFFSET p_offset
  )
  SELECT
    p.total_count::bigint,
    p.id,
    p.shopify_contract_id,
    p.shopify_customer_id,
    p.status,
    p.items,
    p.billing_interval,
    p.billing_interval_count,
    p.next_billing_date,
    p.last_payment_status,
    p.delivery_price_cents,
    p.created_at,
    p.updated_at,
    p.customer_id,
    p.customer_email,
    p.customer_first_name,
    p.customer_last_name,
    p.recovery_status
  FROM paged p;
END;
$$;

COMMENT ON FUNCTION public.list_subscriptions(uuid, text, text, text, text, text[], text, text, int, int) IS
  'Server-side subscription list with product-containment filter (items @> [{"product_id":…}]) and recovery_status derived from the latest dunning_cycles row per contract, applied BEFORE pagination. Replaces a JS product filter that truncated at 1000 rows and a JS recovery filter that ran after query.range(). Backing index: idx_subscriptions_items_gin (jsonb_path_ops). ORDER BY columns qualified against the recovery_filtered alias to avoid OUT-parameter ambiguity.';

GRANT EXECUTE ON FUNCTION public.list_subscriptions(uuid, text, text, text, text, text[], text, text, int, int)
  TO service_role, authenticated;
