-- Fix get_customer_stats_batch: unnest resolve_customer_link_group's new uuid[] return.
--
-- Phase 5 of the aggregation-layer RPC-ification (20261005170000_phase5_detail_view_rpcs.sql)
-- converged every link-group caller on a single primitive by redefining
-- public.resolve_customer_link_group(uuid) to return **uuid[]** (a scalar array), replacing the
-- previous SETOF uuid contract. get_customer_stats_batch was written against the old contract:
-- it expands the group via
--   cross join lateral public.resolve_customer_link_group(i.cid) as g(member_id)
-- then joins `orders.customer_id = e.order_customer_id`. Under the new contract member_id is a
-- uuid[] scalar, not a uuid — so `orders.customer_id = e.order_customer_id` becomes
-- `uuid = uuid[]` and Postgres throws:
--   `operator does not exist: uuid = uuid[]`
-- Result: every hit to /api/tickets/[id] (and every other getCustomerStats caller) 500s with
-- Control Tower signature `vercel:348fa052bf4dc7e4`.
--
-- Fix: adapt the array back into a set with `unnest()` in the same lateral position — a pure
-- array-to-set adapter, no other change to the RPC body. The rest of the function
-- (LTV / order-count / first-last-order aggregation, the `is distinct from 'refunded'` LTV
-- filter, group-by input_customer_id) is byte-identical to 20260708130000_customer_stats_batch_rpc.sql.
-- Signature is unchanged, so no caller in src/lib/customer-stats.ts has to change.
--
-- The unnest() form is deliberately compatible with the array-returning primitive Phase 5 rolled
-- out; the alternative would be reverting resolve_customer_link_group to SETOF uuid, which would
-- re-break the ticket-detail route and customer-timeline that were updated in Phase 5 to consume
-- the array shape.
--
-- CREATE OR REPLACE only — no DROP needed because the return type of get_customer_stats_batch
-- itself is not changing.

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
    cross join lateral unnest(public.resolve_customer_link_group(i.cid)) as g(member_id)
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

grant execute on function public.get_customer_stats_batch(uuid[]) to authenticated, service_role;
