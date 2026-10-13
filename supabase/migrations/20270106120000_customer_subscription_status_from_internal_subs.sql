-- customers.subscription_status — derived from OUR subscriptions for customers on internal billing.
--
-- Problem (measured 2026-10-06): of 153 customers with an ACTIVE internal (Braintree) sub, only 46
-- read subscription_status='active' (100 'never', 7 'cancelled'). The Shopify customers/update
-- webhook (shopify-webhooks.ts) and the Shopify customer sync (shopify-sync.ts) write the column
-- from Shopify's productSubscriberStatus. Shopify only knows Appstle / ShopCX contracts — once a
-- customer's contracts are cancelled for migration it reports them as never-subscribed, and every
-- customer update overwrote our value (55 of 60 sampled wrong rows were last written by it). SMS
-- segments, the AI context, retention scoring and the fraud tools all read this column.
--
-- Fix, at the one chokepoint every writer passes through:
--   * derive_customer_subscription_status(customer) → 'active' > 'paused' > 'cancelled' from
--     public.subscriptions — but ONLY for a customer with at least one internal sub (the engine
--     Shopify cannot see). For everyone else it returns NULL ("no opinion") and Shopify's value
--     stands: for Appstle/ShopCX-only customers Shopify is a legitimate source, and widening this
--     would reclassify ~1,260 Appstle-only customers (mostly never → cancelled) in marketing
--     segments as a side effect. Customers come under the rule automatically as they migrate.
--   * BEFORE INSERT/UPDATE OF subscription_status ON customers: when the derivation has an
--     opinion, it wins over whatever the writer supplied.
--   * AFTER INSERT/DELETE/UPDATE OF status, customer_id, billing_source, is_internal ON
--     subscriptions: recompute for the affected customer(s) (old AND new on a reassignment).
--   * One-time recompute of existing rows (≈120 change). Idempotent: guarded by IS DISTINCT FROM.

create or replace function public.derive_customer_subscription_status(p_customer_id uuid)
returns text
language sql
stable
as $$
  select case
    -- coalesce: over ZERO rows bool_or is NULL, which would fall through to 'cancelled' for
    -- every customer with no subscriptions (including each newly inserted customer).
    when not coalesce(bool_or(coalesce(s.is_internal, false) or s.billing_source = 'internal'), false) then null
    when bool_or(s.status = 'active') then 'active'
    when bool_or(s.status = 'paused') then 'paused'
    else 'cancelled'
  end
  from public.subscriptions s
  where s.customer_id = p_customer_id;
$$;

comment on function public.derive_customer_subscription_status(uuid) is
  'active > paused > cancelled from public.subscriptions, for customers with at least one internal '
  'sub; NULL (no opinion) otherwise. See migration 20270106120000.';

create or replace function public.customers_subscription_status_from_subs()
returns trigger
language plpgsql
as $$
declare
  derived text;
begin
  derived := public.derive_customer_subscription_status(new.id);
  if derived is not null then
    new.subscription_status := derived;
  end if;
  return new;
end;
$$;

drop trigger if exists customers_subscription_status_from_subs on public.customers;
create trigger customers_subscription_status_from_subs
  before insert or update of subscription_status on public.customers
  for each row execute function public.customers_subscription_status_from_subs();

create or replace function public.subscriptions_sync_customer_subscription_status()
returns trigger
language plpgsql
as $$
declare
  ids uuid[] := array[]::uuid[];
  cid uuid;
  derived text;
begin
  if tg_op in ('INSERT', 'UPDATE') and new.customer_id is not null then
    ids := array_append(ids, new.customer_id);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.customer_id is not null
     and (tg_op = 'DELETE' or old.customer_id is distinct from new.customer_id) then
    ids := array_append(ids, old.customer_id);
  end if;
  foreach cid in array ids loop
    derived := public.derive_customer_subscription_status(cid);
    if derived is not null then
      update public.customers
        set subscription_status = derived
        where id = cid and subscription_status is distinct from derived;
    end if;
  end loop;
  return null;
end;
$$;

drop trigger if exists subscriptions_sync_customer_subscription_status on public.subscriptions;
create trigger subscriptions_sync_customer_subscription_status
  after insert or delete or update of status, customer_id, billing_source, is_internal on public.subscriptions
  for each row execute function public.subscriptions_sync_customer_subscription_status();

-- One-time recompute for customers already on internal billing.
update public.customers c
  set subscription_status = d.derived
  from (
    select s.customer_id, public.derive_customer_subscription_status(s.customer_id) as derived
    from public.subscriptions s
    where s.customer_id is not null and (s.is_internal or s.billing_source = 'internal')
    group by s.customer_id
  ) d
  where c.id = d.customer_id
    and d.derived is not null
    and c.subscription_status is distinct from d.derived;
