-- Logistics M3 forecast RPCs. Push the heavy JSONB scans + cadence math into Postgres instead
-- of pulling thousands of order / subscription rows into the app to aggregate. All are pure
-- reads. Subscription monthly-draw multiplier = 30.4375 / (interval_days * interval_count).

-- Storefront (Shopify + internal) units for a Shopify variant over a date window. Replaces a
-- paginated app-side scan of orders.line_items.
create or replace function public.logistics_storefront_units(
  p_workspace uuid, p_variant text, p_since date, p_until date
) returns bigint
language sql stable as $$
  select coalesce(sum((li->>'quantity')::numeric), 0)::bigint
  from public.orders o
  cross join lateral jsonb_array_elements(o.line_items) li
  where o.workspace_id = p_workspace
    and (li->>'variant_id') = p_variant
    and o.created_at >= p_since
    and o.created_at < (p_until + interval '1 day');
$$;

-- Active-subscriber monthly unit draw for a SKU, optionally EXCLUDING a crisis cohort (the
-- "true subscribers, preserve at all costs" floor). Cadence math done in SQL.
create or replace function public.logistics_subscriber_units_mo(
  p_workspace uuid, p_sku text, p_exclude_crisis uuid default null
) returns numeric
language sql stable as $$
  select coalesce(sum(
    (select coalesce(sum((it->>'quantity')::numeric), 0)
       from jsonb_array_elements(s.items) it where it->>'sku' = p_sku)
    * (30.4375 / (case s.billing_interval when 'week' then 7 when 'day' then 1 when 'year' then 365 else 30.4375 end
                  * coalesce(nullif(s.billing_interval_count, 0), 1)))
  ), 0)
  from public.subscriptions s
  where s.workspace_id = p_workspace
    and s.status = 'active'
    and (p_exclude_crisis is null
         or not exists (select 1 from public.crisis_customer_actions a
                        where a.subscription_id = s.id and a.crisis_id = p_exclude_crisis));
$$;

-- Crisis cohort joined to their subscriptions in ONE call (replaces a chunked .in() fan-out).
-- The app does the light per-sub aggregation (swap-title match, status nuance).
create or replace function public.logistics_crisis_subscriptions(p_crisis_id uuid)
returns table (
  subscription_id uuid, status text, billing_interval text, billing_interval_count integer,
  items jsonb, tier1_swapped_to jsonb, tier2_swapped_to jsonb, auto_readd boolean, cancelled boolean
)
language sql stable as $$
  select a.subscription_id, s.status, s.billing_interval, s.billing_interval_count,
         s.items, a.tier1_swapped_to, a.tier2_swapped_to, a.auto_readd, a.cancelled
  from public.crisis_customer_actions a
  join public.subscriptions s on s.id = a.subscription_id
  where a.crisis_id = p_crisis_id;
$$;

grant execute on function public.logistics_storefront_units(uuid, text, date, date) to authenticated, service_role;
grant execute on function public.logistics_subscriber_units_mo(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.logistics_crisis_subscriptions(uuid) to authenticated, service_role;
