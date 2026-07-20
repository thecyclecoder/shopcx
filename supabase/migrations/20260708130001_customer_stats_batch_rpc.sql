-- get_customer_stats_batch + resolve_customer_link_group — server-side customer LTV / order-count rollup.
--
-- Fixes a LIVE correctness bug in src/lib/customer-stats.ts getCustomerStatsBatch(): it expanded
-- customer_links groups in JS then did ONE unbounded `.from('orders').select(...).in('customer_id', [...])`
-- and summed LTV / counted orders in JS. That `.in()` read is silently truncated at Supabase's 1000-row
-- PostgREST response cap, so on any page whose customers collectively have >1000 orders (routine on a
-- subscription store) rows past 1000 are dropped and the customers-list sortable `ltv_cents` /
-- `total_orders` columns are UNDERCOUNTED. Same bug class as the estimate_sub_ltv incident (20260708120000).
-- Pushing the join + aggregation server-side removes the cap (sees all rows) and the row-shipping egress.
--
-- SEMANTICS ARE PRESERVED EXACTLY (this is a pure truncation fix, not a semantics change):
--   * LTV excludes ONLY financial_status = 'refunded' (lowercase). NULL counts toward LTV, and — matching
--     the current JS `!== 'refunded'` — uppercase 'REFUNDED' / 'PARTIALLY_REFUNDED' ALSO still count.
--     (`is distinct from 'refunded'` reproduces `!== 'refunded'` incl. the NULL-counts behaviour.)
--     NOTE: the mixed-casing exclusion gap is a separate known issue, deliberately NOT changed here so
--     this migration's numeric impact is attributable purely to de-truncation.
--   * total_orders counts ALL orders (refunded included).
--   * first/last_order_at are min/max(created_at) over ALL orders (refunded included).
--   * linked-account rollup: each input customer sees the combined orders of its customer_links group.
--
-- resolve_customer_link_group(uuid) is the reusable group-expansion the audit flagged — customer-stats,
-- customer-timeline, and the storefront LTV proxy each re-implement this in JS; this is the shared SQL
-- primitive they can converge on. customer_links.customer_id is unique (getCustomerStats uses
-- .maybeSingle()), so a customer is in <=1 group and the expansion is unambiguous.

drop function if exists public.get_customer_stats_batch(uuid[]);
drop function if exists public.resolve_customer_link_group(uuid);

-- Group members for a customer: all customers sharing its customer_links group; just the customer
-- itself when it belongs to no group.
create or replace function public.resolve_customer_link_group(p_customer_id uuid)
returns setof uuid
language sql
stable
as $$
  select m.customer_id
  from public.customer_links self
  join public.customer_links m on m.group_id = self.group_id
  where self.customer_id = p_customer_id
  union
  select p_customer_id
  where not exists (
    select 1 from public.customer_links where customer_id = p_customer_id
  );
$$;

-- Batch LTV / order-count / first-last-order rollup, one row per input id (present even with 0 orders).
create or replace function public.get_customer_stats_batch(p_customer_ids uuid[])
returns table (
  input_customer_id uuid,
  ltv_cents bigint,
  total_orders bigint,
  first_order_at timestamptz,
  last_order_at timestamptz
)
language sql
stable
as $$
  with inputs as (
    select distinct unnest(p_customer_ids) as cid
  ),
  expanded as (
    select i.cid as input_customer_id, g.member_id as order_customer_id
    from inputs i
    cross join lateral public.resolve_customer_link_group(i.cid) as g(member_id)
  )
  select
    e.input_customer_id,
    coalesce(
      sum(o.total_cents) filter (where o.financial_status is distinct from 'refunded'),
      0
    )::bigint                                    as ltv_cents,
    count(o.id)::bigint                          as total_orders,
    min(o.created_at)                            as first_order_at,
    max(o.created_at)                            as last_order_at
  from expanded e
  left join public.orders o on o.customer_id = e.order_customer_id
  group by e.input_customer_id;
$$;

grant execute on function public.resolve_customer_link_group(uuid) to authenticated, service_role;
grant execute on function public.get_customer_stats_batch(uuid[]) to authenticated, service_role;
