-- Phase 3 of docs/brain/specs/rpc-ify-aggregation-layer-fix-1000-row-truncation.md.
--
-- Three RPCs that fix aggregation correctness + kill unbounded orders-table
-- egress from callers that previously paged or unbounded-selected the table:
--
--   1. public.amplifier_is_late(...)             — internal SQL predicate for #2
--   2. public.orders_late_tracking_count(...)    — cheap count for the tab
--   3. public.orders_late_tracking(...)          — paginated list + true total
--   4. public.order_source_counts(p_workspace)   — GROUP BY source_name
--   5. public.order_times_by_email(p_workspace,  — join carts→customers→orders
--                                  p_emails)       server-side for the cart
--                                                  recovery post-reminder test
--
-- The prior JS versions of #2-5 all fetched raw orders rows to app then
-- aggregated / filtered in memory. src/app/api/workspaces/[id]/orders/route.ts
-- for late-tracking dropped .range() to run isWithinSLA() over every match, so
-- once the match set exceeded 1000 rows PostgREST silently dropped the tail
-- and the counted "late" number was wrong. src/app/api/workspaces/[id]/order-sources/route.ts
-- looped .range(0, 999) through the whole orders table just to GROUP BY
-- source_name. src/lib/storefront/funnel-tree.ts chunked customer_ids in
-- groups of 200 and then read `.in("customer_id", chunk)` on orders — a chunk
-- with >1000 order rows dropped the tail, so the "customer ordered AFTER
-- the reminder" test on cart recovery under-counted recovered carts.

-- ── 1. amplifier_is_late — the SLA predicate factored out for reuse ──────────
-- Ports the JS isWithinSLA from src/app/api/workspaces/[id]/orders/route.ts
-- verbatim: convert to workspace TZ, roll to next business day if past cutoff
-- hour, advance to the next shipping day, then count sla_days more shipping
-- days; the deadline is 23:59:59 on that day (workspace-local). Returns
-- true when the current wall-clock in TZ is PAST that deadline.
-- Postgres isodow (Mon=1..Sun=7) matches the JS toISO() the original used.
CREATE OR REPLACE FUNCTION public.amplifier_is_late(
  p_received timestamptz,
  p_sla_days int,
  p_cutoff_hour int,
  p_cutoff_timezone text,
  p_shipping_days int[]
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_received_local timestamp;
  v_current date;
  v_current_dow int;
  v_deadline timestamp;
  v_now_local timestamp;
  v_counted int := 0;
  v_tz text := coalesce(nullif(p_cutoff_timezone, ''), 'America/Chicago');
  v_sla int := coalesce(p_sla_days, 1);
  v_cutoff int := coalesce(p_cutoff_hour, 11);
  v_days int[] := coalesce(p_shipping_days, ARRAY[1,2,3,4,5]);
BEGIN
  IF p_received IS NULL THEN RETURN false; END IF;

  v_received_local := (p_received AT TIME ZONE v_tz);
  v_current := v_received_local::date;
  IF extract(hour from v_received_local) >= v_cutoff THEN
    v_current := v_current + 1;
  END IF;

  -- Advance to next shipping day. Bound the loop as a defensive belt (a caller
  -- passing an empty shipping_days array would otherwise loop forever); the
  -- coalesce default covers the empty-array case.
  FOR i IN 0..14 LOOP
    v_current_dow := extract(isodow from v_current)::int;
    EXIT WHEN v_current_dow = ANY(v_days);
    v_current := v_current + 1;
  END LOOP;

  -- Advance sla shipping days from that starting day
  WHILE v_counted < v_sla LOOP
    v_current := v_current + 1;
    v_current_dow := extract(isodow from v_current)::int;
    IF v_current_dow = ANY(v_days) THEN
      v_counted := v_counted + 1;
    END IF;
  END LOOP;

  v_deadline := v_current + time '23:59:59';
  v_now_local := (now() AT TIME ZONE v_tz);
  -- Original JS returned `nowInTZ <= current` for "within SLA" → late is >.
  RETURN v_now_local > v_deadline;
END;
$$;

COMMENT ON FUNCTION public.amplifier_is_late(timestamptz, int, int, text, int[]) IS
  'SQL parity port of src/app/api/workspaces/[id]/orders/route.ts isWithinSLA — returns true when now-in-TZ is past the SLA deadline (23:59:59 on the deadline shipping day). Used by orders_late_tracking* RPCs.';


-- ── 2. orders_late_tracking_count — cheap count for the counts endpoint ─────
CREATE OR REPLACE FUNCTION public.orders_late_tracking_count(
  p_workspace uuid,
  p_sla_days int,
  p_cutoff_hour int,
  p_cutoff_timezone text,
  p_shipping_days int[]
) RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::bigint
  FROM public.orders o
  WHERE o.workspace_id = p_workspace
    AND o.amplifier_order_id IS NOT NULL
    AND o.amplifier_received_at IS NOT NULL
    AND o.amplifier_shipped_at IS NULL
    AND (o.fulfillment_status IS NULL OR o.fulfillment_status NOT ILIKE 'fulfilled')
    AND o.financial_status = 'paid'
    AND public.amplifier_is_late(
      o.amplifier_received_at,
      p_sla_days,
      p_cutoff_hour,
      p_cutoff_timezone,
      p_shipping_days
    );
$$;

COMMENT ON FUNCTION public.orders_late_tracking_count(uuid, int, int, text, int[]) IS
  'Late-tracking count for /api/workspaces/:id/orders?counts=true — replaces a JS isWithinSLA() loop over a 1000-row-capped candidate select. Returns the true count over the full late set.';

GRANT EXECUTE ON FUNCTION public.orders_late_tracking_count(uuid, int, int, text, int[])
  TO service_role, authenticated;


-- ── 3. orders_late_tracking — paginated late-tracking list + total ──────────
-- Returns rows enriched with the joined customers.{email, first_name,
-- last_name}. The caller shape mirrors the prior route's response object.
DROP FUNCTION IF EXISTS public.orders_late_tracking(uuid, int, int, text, int[], text, text, int, int);

CREATE OR REPLACE FUNCTION public.orders_late_tracking(
  p_workspace uuid,
  p_sla_days int,
  p_cutoff_hour int,
  p_cutoff_timezone text,
  p_shipping_days int[],
  p_sort text,
  p_order text,
  p_limit int,
  p_offset int
) RETURNS TABLE(
  total_count bigint,
  id uuid,
  order_number text,
  email text,
  total_cents bigint,
  currency text,
  financial_status text,
  fulfillment_status text,
  line_items jsonb,
  created_at timestamptz,
  tags text,
  source_name text,
  amplifier_order_id uuid,
  amplifier_received_at timestamptz,
  amplifier_shipped_at timestamptz,
  amplifier_tracking_number text,
  amplifier_carrier text,
  amplifier_status text,
  delivery_status text,
  delivered_at timestamptz,
  customer_id uuid,
  shopify_order_id text,
  customer_email text,
  customer_first_name text,
  customer_last_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sort text := lower(coalesce(p_sort, 'created_at'));
  v_asc  boolean := (lower(coalesce(p_order, 'desc')) <> 'desc');
BEGIN
  IF v_sort NOT IN ('created_at', 'order_number', 'total_cents', 'fulfillment_status') THEN
    v_sort := 'created_at';
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT o.*
    FROM public.orders o
    WHERE o.workspace_id = p_workspace
      AND o.amplifier_order_id IS NOT NULL
      AND o.amplifier_received_at IS NOT NULL
      AND o.amplifier_shipped_at IS NULL
      AND (o.fulfillment_status IS NULL OR o.fulfillment_status NOT ILIKE 'fulfilled')
      AND o.financial_status = 'paid'
      AND public.amplifier_is_late(
        o.amplifier_received_at,
        p_sla_days,
        p_cutoff_hour,
        p_cutoff_timezone,
        p_shipping_days
      )
  ),
  paged AS (
    SELECT
      f.*,
      count(*) OVER () AS total_count
    FROM filtered f
    ORDER BY
      CASE WHEN v_sort = 'created_at'          AND v_asc     THEN f.created_at END ASC NULLS LAST,
      CASE WHEN v_sort = 'created_at'          AND NOT v_asc THEN f.created_at END DESC NULLS LAST,
      CASE WHEN v_sort = 'order_number'        AND v_asc     THEN f.order_number END ASC NULLS LAST,
      CASE WHEN v_sort = 'order_number'        AND NOT v_asc THEN f.order_number END DESC NULLS LAST,
      CASE WHEN v_sort = 'total_cents'         AND v_asc     THEN f.total_cents END ASC NULLS LAST,
      CASE WHEN v_sort = 'total_cents'         AND NOT v_asc THEN f.total_cents END DESC NULLS LAST,
      CASE WHEN v_sort = 'fulfillment_status'  AND v_asc     THEN f.fulfillment_status END ASC NULLS LAST,
      CASE WHEN v_sort = 'fulfillment_status'  AND NOT v_asc THEN f.fulfillment_status END DESC NULLS LAST,
      f.id ASC
    LIMIT p_limit OFFSET p_offset
  )
  SELECT
    p.total_count::bigint,
    p.id,
    p.order_number,
    p.email,
    p.total_cents::bigint,
    p.currency,
    p.financial_status,
    p.fulfillment_status,
    p.line_items,
    p.created_at,
    p.tags,
    p.source_name,
    p.amplifier_order_id,
    p.amplifier_received_at,
    p.amplifier_shipped_at,
    p.amplifier_tracking_number,
    p.amplifier_carrier,
    p.amplifier_status,
    p.delivery_status,
    p.delivered_at,
    p.customer_id,
    p.shopify_order_id,
    c.email        AS customer_email,
    c.first_name   AS customer_first_name,
    c.last_name    AS customer_last_name
  FROM paged p
  LEFT JOIN public.customers c ON c.id = p.customer_id;
END;
$$;

COMMENT ON FUNCTION public.orders_late_tracking(uuid, int, int, text, int[], text, text, int, int) IS
  'Paginated late-tracking list for /api/workspaces/:id/orders?filter=late_tracking. Replaces a fetch-all-candidates + JS isWithinSLA + JS slice. Returns rows enriched with customer names + total_count (COUNT(*) OVER () over the full late set), applied BEFORE pagination.';

GRANT EXECUTE ON FUNCTION public.orders_late_tracking(uuid, int, int, text, int[], text, text, int, int)
  TO service_role, authenticated;


-- ── 4. order_source_counts — GROUP BY source_name ───────────────────────────
CREATE OR REPLACE FUNCTION public.order_source_counts(
  p_workspace uuid
) RETURNS TABLE(
  source_name text,
  cnt bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(o.source_name, '(unknown)') AS source_name,
         COUNT(*)::bigint                     AS cnt
  FROM public.orders o
  WHERE o.workspace_id = p_workspace
  GROUP BY COALESCE(o.source_name, '(unknown)')
  ORDER BY cnt DESC;
$$;

COMMENT ON FUNCTION public.order_source_counts(uuid) IS
  'GROUP BY source_name over the workspace orders. Replaces the while(true) .range(0,999) loop in /api/workspaces/:id/order-sources that paged the entire orders table into a JS Map.';

GRANT EXECUTE ON FUNCTION public.order_source_counts(uuid)
  TO service_role, authenticated;


-- ── 5. order_times_by_email — cart recovery post-reminder-purchase test ─────
-- Powers src/lib/storefront/funnel-tree.ts's "did the customer order after the
-- reminder?" check. Prior version chunked customer_ids in groups of 200 and
-- issued `.in("customer_id", chunk)` on orders — a chunk with >1000 order
-- rows silently dropped the tail, so recovered-cart counts were low-biased.
-- Returns one row per email in p_emails (case-insensitive) with the array of
-- order created_at times for any customer sharing that email in the workspace.
CREATE OR REPLACE FUNCTION public.order_times_by_email(
  p_workspace uuid,
  p_emails text[]
) RETURNS TABLE(
  email text,
  order_times timestamptz[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH input AS (
    SELECT DISTINCT lower(e) AS email
    FROM unnest(coalesce(p_emails, ARRAY[]::text[])) e
    WHERE e IS NOT NULL AND e <> ''
  ),
  matched_customers AS (
    SELECT lower(c.email) AS email, c.id AS customer_id
    FROM public.customers c
    JOIN input i ON i.email = lower(c.email)
    WHERE c.workspace_id = p_workspace
  ),
  matched_orders AS (
    SELECT mc.email, o.created_at
    FROM matched_customers mc
    JOIN public.orders o ON o.customer_id = mc.customer_id
    WHERE o.created_at IS NOT NULL
  )
  SELECT mo.email,
         ARRAY_AGG(mo.created_at ORDER BY mo.created_at) AS order_times
  FROM matched_orders mo
  GROUP BY mo.email;
$$;

COMMENT ON FUNCTION public.order_times_by_email(uuid, text[]) IS
  'Server-side per-email order-time aggregation for the cart-recovery post-reminder-purchase test in src/lib/storefront/funnel-tree.ts. Replaces a chunked customer_id .in() loop where a chunk with >1000 orders dropped rows past the 1000-cap.';

GRANT EXECUTE ON FUNCTION public.order_times_by_email(uuid, text[])
  TO service_role, authenticated;
