-- Set-based customer-segment refresh — replaces the per-customer read/compute/write loop
-- (scripts/refresh-customer-segments.ts + src/lib/inngest/refresh-customer-segments.ts) that
-- issued ~138K individual UPDATE round-trips and took ~3 hours. This computes every segment in
-- ONE SQL statement inside Postgres (seconds), and is EXACT — no PostgREST 1000-row-cap
-- truncation of a heavy customer's orders/events (the old chunked `.in(100 ids)` reads could
-- silently drop rows past 1000 and mis-segment).
--
-- Segment logic mirrors computeSegments() byte-for-byte (validated on a 400-customer sample):
--   cold          orders=0
--   single_order  orders=1
--   just_ordered  orders>=2 AND ratio<0.5
--   cycle_hitter  orders>=2 AND (0.5<=ratio<=1.5, OR meanGap=0)
--   lapsed        orders>=2 AND 1.5<ratio<=3.0
--   deep_lapsed   orders>=2 AND ratio>3.0
--   engaged       orders>=1 AND (clicked_email_60d>=1 OR atc_30d>=1 OR checkout_30d>=1 OR views_30d>=2)
--   active_sub    any subscription status='active'
--   storefront_signup  any storefront_leads row
-- ratio = daysSinceLast / meanGap; meanGap = (last-first)/(n-1) (telescoped consecutive gaps).
-- Array order (cold/single/archetype) || engaged || active_sub || storefront_signup — matches the JS push order.
--
-- See docs/brain/inngest/refresh-customer-segments.md.

create or replace function public.refresh_customer_segments(
  p_workspace_id uuid,
  p_all boolean default false
)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  with scope as (
    select c.id
    from customers c
    where c.workspace_id = p_workspace_id
      and (p_all or c.sms_marketing_status = 'subscribed')
  ),
  ord as (
    select o.customer_id, count(*)::int n, min(o.created_at) fo, max(o.created_at) lo
    from orders o
    where o.customer_id in (select id from scope)
    group by o.customer_id
  ),
  eng as (
    select pe.customer_id,
      count(*) filter (where pe.metric_name = 'Clicked Email')                                                   ce,
      count(*) filter (where pe.metric_name = 'Added to Cart'    and pe.datetime >= now() - interval '30 days')  atc,
      count(*) filter (where pe.metric_name = 'Checkout Started' and pe.datetime >= now() - interval '30 days')  co,
      count(*) filter (where pe.metric_name = 'Viewed Product'   and pe.datetime >= now() - interval '30 days')  vp
    from profile_events pe
    where pe.workspace_id = p_workspace_id
      and pe.datetime >= now() - interval '60 days'
      and pe.metric_name in ('Clicked Email','Added to Cart','Checkout Started','Viewed Product')
      and pe.customer_id in (select id from scope)
    group by pe.customer_id
  ),
  sub as (
    select distinct s.customer_id
    from subscriptions s
    where s.status = 'active' and s.customer_id in (select id from scope)
  ),
  lead as (
    select distinct l.customer_id
    from storefront_leads l
    where l.workspace_id = p_workspace_id and l.customer_id is not null
      and l.customer_id in (select id from scope)
  ),
  computed as (
    select sc.id,
      (case
         when coalesce(o.n, 0) = 0 then array['cold']
         when o.n = 1 then array['single_order']
         when o.lo = o.fo then array['cycle_hitter']  -- meanGap=0 (ratio null) → cycle_hitter, mirrors JS
         else case
           when (extract(epoch from (now() - o.lo)) * (o.n - 1)) / extract(epoch from (o.lo - o.fo)) <  0.5 then array['just_ordered']
           when (extract(epoch from (now() - o.lo)) * (o.n - 1)) / extract(epoch from (o.lo - o.fo)) <= 1.5 then array['cycle_hitter']
           when (extract(epoch from (now() - o.lo)) * (o.n - 1)) / extract(epoch from (o.lo - o.fo)) <= 3.0 then array['lapsed']
           else array['deep_lapsed']
         end
       end)
      || case when coalesce(o.n,0) >= 1 and (coalesce(e.ce,0) >= 1 or coalesce(e.atc,0) >= 1 or coalesce(e.co,0) >= 1 or coalesce(e.vp,0) >= 2)
              then array['engaged'] else '{}'::text[] end
      || case when su.customer_id is not null then array['active_sub'] else '{}'::text[] end
      || case when le.customer_id is not null then array['storefront_signup'] else '{}'::text[] end
      as segments
    from scope sc
    left join ord  o  on o.customer_id  = sc.id
    left join eng  e  on e.customer_id  = sc.id
    left join sub  su on su.customer_id = sc.id
    left join lead le on le.customer_id = sc.id
  )
  update customers c
  set segments = x.segments,
      segments_refreshed_at = now()
  from computed x
  where c.id = x.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.refresh_customer_segments(uuid, boolean) to service_role;
