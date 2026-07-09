-- Phase 4 of docs/brain/specs/rpc-ify-aggregation-layer-fix-1000-row-truncation.md.
--
-- Two RPCs that kill "page every row into JS then aggregate" egress at the two
-- worst offenders the audit flagged:
--
--   1. public.crisis_affected_subs  — /api/workspaces/:id/crisis/:crisisId
--        replaces a `while(true) .range()` loop that paged every active/paused
--        subscription in the workspace to app just to apply a JS
--        items.some(i => i.sku==='X' || i.variant_id==='Y') filter + a JS MRR
--        reduce over the survivors. Filter + MRR sum now run server-side; the
--        RPC returns { affected_count, monthly_revenue_cents, sub_ids }.
--
--   2. public.onsite_nonrenewal_revenue — src/lib/shopify-internal-revenue.ts
--        replaces the paginated orders scan + JS variantToProduct map lookup +
--        JS bucketOrder replay + JS Meta-UTM filter. The RPC does the
--        variant→product join, applies the same bucket predicate (workspace
--        order_source_mapping + tags + subscription_id) in SQL, and returns
--        one aggregate row per matched product_id. Called once per linked
--        group instead of per-group fan-out.

-- ── 1. crisis_affected_subs ─────────────────────────────────────────────────
-- Match subs whose items JSONB carries either the affected sku (case-insensitive)
-- or the affected variant_id (as text). Then sum a monthly-normalized revenue
-- server-side: interval = MONTH → (Σ price*qty)/count; WEEK → ×(4.33/count);
-- DAY → ×(30/count). Preserves the JS math bit-for-bit.
CREATE OR REPLACE FUNCTION public.crisis_affected_subs(
  p_workspace uuid,
  p_variant_id text,
  p_sku text
) RETURNS TABLE(
  affected_count bigint,
  monthly_revenue_cents bigint,
  sub_ids uuid[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH matched AS (
    SELECT s.id,
           s.items,
           coalesce(s.billing_interval, 'MONTH') AS interval_raw,
           coalesce(s.billing_interval_count, 1) AS interval_count
    FROM public.subscriptions s
    WHERE s.workspace_id = p_workspace
      AND s.status IN ('active', 'paused')
      AND (
        (p_variant_id IS NOT NULL AND p_variant_id <> '' AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(coalesce(s.items, '[]'::jsonb)) it
          WHERE it->>'variant_id' = p_variant_id
        ))
        OR
        (p_sku IS NOT NULL AND p_sku <> '' AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(coalesce(s.items, '[]'::jsonb)) it
          WHERE upper(it->>'sku') = upper(p_sku)
        ))
      )
  ),
  per_sub AS (
    SELECT m.id,
           m.interval_raw,
           m.interval_count,
           coalesce((
             SELECT sum(
               coalesce((it->>'price_cents')::numeric, 0)
               * coalesce((it->>'quantity')::numeric, 1)
             )
             FROM jsonb_array_elements(coalesce(m.items, '[]'::jsonb)) it
           ), 0) AS sub_total_cents
    FROM matched m
  ),
  normalized AS (
    SELECT p.id,
           CASE upper(p.interval_raw)
             WHEN 'WEEK' THEN p.sub_total_cents * (4.33 / NULLIF(p.interval_count, 0))
             WHEN 'DAY'  THEN p.sub_total_cents * (30.0 / NULLIF(p.interval_count, 0))
             ELSE              p.sub_total_cents / NULLIF(p.interval_count, 0)
           END AS monthly_cents
    FROM per_sub p
  )
  SELECT
    (SELECT count(*)::bigint FROM matched)                                                    AS affected_count,
    (SELECT coalesce(round(sum(monthly_cents)), 0)::bigint FROM normalized)                   AS monthly_revenue_cents,
    (SELECT coalesce(array_agg(id ORDER BY id), ARRAY[]::uuid[]) FROM matched)                AS sub_ids;
$$;

COMMENT ON FUNCTION public.crisis_affected_subs(uuid, text, text) IS
  'Server-side aggregate for /api/workspaces/:id/crisis/:crisisId — matches active/paused subs by variant_id or SKU (case-insensitive), sums monthly-normalized revenue, returns (affected_count, monthly_revenue_cents, sub_ids). Replaces a while(true) .range() loop over all active/paused subs + JS items.some + JS MRR reduce.';

GRANT EXECUTE ON FUNCTION public.crisis_affected_subs(uuid, text, text)
  TO service_role, authenticated;


-- ── 2. onsite_nonrenewal_revenue ────────────────────────────────────────────
-- Sums per-product on-site NON-RENEWAL revenue over [p_start, p_end] Central time
-- for the linked-group's product_ids. Applies the SAME order-bucketing family
-- the JS bucketOrder in src/lib/order-bucketing.ts uses so the wire result can't
-- drift from the snapshot/ROAS route.
--
--   non_renewal := bucket ∈ { new_sub, one_time }
--   recurring   := workspace order_source_mapping[source_name] == 'recurring'
--                  OR source_name contains 'subscription'
--   replacement := workspace order_source_mapping[source_name] == 'replacement'
--                  OR source_name == 'shopify_draft_order'
--   new_sub     := (tags contain 'first subscription') OR subscription_id IS NOT NULL
--   one_time    := otherwise
--
-- Line-item revenue: for each order in the window that buckets non-renewal
-- (and optionally passes the Meta-UTM family filter), each line whose
-- variant_id maps to a product_id in p_product_ids contributes
-- price_cents × quantity. The orderCount per product counts the order once
-- regardless of how many matching lines it carries (matching the JS
-- productsTouched pass).
CREATE OR REPLACE FUNCTION public.onsite_nonrenewal_revenue(
  p_workspace uuid,
  p_product_ids uuid[],
  p_start date,
  p_end date,
  p_meta_only boolean
) RETURNS TABLE(
  product_id uuid,
  gross_cents bigint,
  units bigint,
  order_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH cfg AS (
    -- The Central-time [start, end] window converts to UTC via the +05:00 CDT
    -- offset the JS caller applied — kept explicit so the SQL matches parity.
    SELECT
      ((p_start::text) || 'T05:00:00Z')::timestamptz                              AS utc_start,
      (((p_end + 1)::text) || 'T05:00:00Z')::timestamptz                          AS utc_end,
      coalesce((SELECT order_source_mapping
                FROM public.workspaces WHERE id = p_workspace), '{}'::jsonb)      AS source_mapping
  ),
  variants AS (
    SELECT v.shopify_variant_id, v.product_id
    FROM public.product_variants v
    WHERE v.workspace_id = p_workspace
      AND v.product_id = ANY(p_product_ids)
      AND v.shopify_variant_id IS NOT NULL
  ),
  win_orders AS (
    SELECT o.id, o.source_name, o.tags, o.subscription_id, o.attributed_utm_source, o.line_items
    FROM public.orders o, cfg
    WHERE o.workspace_id = p_workspace
      AND o.created_at >= cfg.utc_start
      AND o.created_at <  cfg.utc_end
  ),
  bucketed AS (
    SELECT
      o.*,
      CASE
        -- recurring: mapped=recurring OR source contains 'subscription'
        WHEN (cfg.source_mapping ->> coalesce(o.source_name, 'unknown')) = 'recurring'
             OR coalesce(o.source_name, '') ILIKE '%subscription%'
          THEN 'recurring'
        -- replacement: mapped=replacement OR draft
        WHEN (cfg.source_mapping ->> coalesce(o.source_name, 'unknown')) = 'replacement'
             OR o.source_name = 'shopify_draft_order'
          THEN 'replacement'
        -- new_sub: first-subscription tag OR has subscription_id
        WHEN (
             o.tags IS NOT NULL AND lower(o.tags) LIKE '%first subscription%'
          )
             OR o.subscription_id IS NOT NULL
          THEN 'new_sub'
        ELSE 'one_time'
      END AS bucket
    FROM win_orders o, cfg
  ),
  non_renewal AS (
    SELECT b.*
    FROM bucketed b
    WHERE b.bucket IN ('new_sub', 'one_time')
      AND (
        NOT p_meta_only
        OR (
          b.attributed_utm_source IS NOT NULL
          AND (
            lower(b.attributed_utm_source) LIKE '%meta%'
            OR lower(b.attributed_utm_source) LIKE '%facebook%'
            OR lower(b.attributed_utm_source) LIKE '%instagram%'
            OR lower(b.attributed_utm_source) = 'fb'
            OR lower(b.attributed_utm_source) = 'ig'
          )
        )
      )
  ),
  -- Explode line_items with the resolved product_id, dropping lines whose
  -- variant isn't in the group's variant set.
  lines AS (
    SELECT
      nr.id AS order_id,
      v.product_id,
      coalesce((li->>'quantity')::numeric, 0)   AS qty,
      coalesce((li->>'price_cents')::numeric, 0) AS price_cents
    FROM non_renewal nr
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(nr.line_items, '[]'::jsonb)) li
    JOIN variants v ON v.shopify_variant_id = (li->>'variant_id')
  ),
  per_product_order AS (
    SELECT order_id,
           product_id,
           sum(qty)                       AS units,
           sum(price_cents * qty)         AS gross_cents
    FROM lines
    GROUP BY order_id, product_id
  ),
  per_product AS (
    SELECT
      product_id,
      coalesce(round(sum(gross_cents)), 0)::bigint AS gross_cents,
      coalesce(sum(units), 0)::bigint              AS units,
      count(DISTINCT order_id)::bigint             AS order_count
    FROM per_product_order
    GROUP BY product_id
  )
  -- Per-product rows...
  SELECT product_id, gross_cents, units, order_count FROM per_product
  UNION ALL
  -- ...plus one aggregate row where product_id IS NULL carrying the overall
  -- order_count (distinct orders that contributed ≥1 matching line, matching
  -- the JS `if (productsTouched.size) out.orderCount += 1;` semantic). The
  -- caller unpacks the NULL row into out.orderCount and the rest into
  -- out.byProduct.
  SELECT
    NULL::uuid                                                             AS product_id,
    coalesce((SELECT sum(gross_cents) FROM per_product), 0)::bigint        AS gross_cents,
    coalesce((SELECT sum(units) FROM per_product), 0)::bigint              AS units,
    (SELECT count(DISTINCT order_id) FROM per_product_order)::bigint       AS order_count;
$$;

COMMENT ON FUNCTION public.onsite_nonrenewal_revenue(uuid, uuid[], date, date, boolean) IS
  'Server-side per-product on-site NON-RENEWAL revenue over the CT window. Replaces src/lib/shopify-internal-revenue.ts paginated orders scan + JS bucketOrder replay + JS variantToProduct + JS Meta-UTM filter. Returns per-product { gross_cents, units, order_count } — orderCount counts an order once per product it touched, matching the JS productsTouched pass.';

GRANT EXECUTE ON FUNCTION public.onsite_nonrenewal_revenue(uuid, uuid[], date, date, boolean)
  TO service_role, authenticated;
