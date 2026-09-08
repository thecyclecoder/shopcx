-- daily_order_snapshots.native_count — how many of the day's orders are ShopCX-native
-- (no shopify_order_id: storefront / internal_subscription_renewal / comp).
--
-- Why: the shopify_mismatch check used to compare Shopify's own order count against the FULL
-- DB total. Since the Braintree migration off Appstle/Shopify a growing share of real orders
-- exist only in ShopCX and Shopify structurally cannot count them, so every day mismatched
-- (86 of the 99 days to 2026-09-07; the monthly delta reconciled exactly to the native count:
-- Jun -40/40, Jul -66/66, Aug -118/118). The comparison is now Shopify-origin-only, and this
-- column records the excluded population so a row explains its own delta without re-deriving it.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + an idempotent recompute of the historical rows.
-- See docs/brain/tables/daily_order_snapshots.md.

alter table public.daily_order_snapshots
  add column if not exists native_count integer not null default 0;

comment on column public.daily_order_snapshots.native_count is
  'Orders that day with no shopify_order_id (ShopCX-native: storefront, internal_subscription_renewal, comp). Excluded from the shopify_mismatch comparison — Shopify cannot count them.';

comment on column public.daily_order_snapshots.shopify_mismatch is
  'True when Shopify''s own order count for the day differs from the count of SHOPIFY-ORIGIN orders in our DB. Never compare against total_count — that includes ShopCX-native orders Shopify never sees.';

-- Backfill native_count and re-derive shopify_mismatch for every historical row, using each
-- row's own stored utc_start/utc_end window (the same boundaries the snapshot computed with)
-- so the recompute cannot drift from what the cron would have produced.
with counts as (
  select
    s.id,
    count(*) filter (where o.shopify_order_id is null) as native,
    count(*) filter (where o.shopify_order_id is not null) as shopify_origin
  from public.daily_order_snapshots s
  left join public.orders o
    on o.workspace_id = s.workspace_id
   and o.created_at >= s.utc_start
   and o.created_at <  s.utc_end
  group by s.id
)
update public.daily_order_snapshots s
set native_count = c.native,
    shopify_mismatch = case
      when s.shopify_count is null then s.shopify_mismatch  -- never validated; leave as-is
      else s.shopify_count <> c.shopify_origin
    end
from counts c
where c.id = s.id
  and (s.native_count is distinct from c.native
       or (s.shopify_count is not null
           and s.shopify_mismatch is distinct from (s.shopify_count <> c.shopify_origin)));

-- Retire the false-positive alert cards. Every order_sync_mismatch card was raised by the old
-- full-DB-total comparison, and the insert was unconditional, so the self-heal cron's 7-day
-- re-fire produced 8 cards per flagged day (676 in total by 2026-09-08). Only cards whose day is
-- no longer flagged are removed — a genuinely-gapped day keeps its card as the durable record.
-- Idempotent: re-running deletes nothing once the set is empty.
delete from public.dashboard_notifications dn
using public.daily_order_snapshots s
where dn.metadata->>'type' = 'order_sync_mismatch'
  and s.workspace_id = dn.workspace_id
  and s.snapshot_date = (dn.metadata->>'date')::date
  and s.shopify_mismatch = false;
