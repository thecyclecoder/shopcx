-- Which engine is responsible for BILLING this subscription.
--
-- Until now the routing question was answered by `is_internal` / an `internal-` contract-id
-- prefix, which only distinguishes "our Braintree path" from "the vendor". The Appstle→ShopCX
-- migration adds a third answer — a Shopify subscription contract that OUR app owns and OUR
-- scheduler bills — so a two-valued flag can no longer express it.
--
--   'appstle'  Appstle's scheduler bills it. The default, and true of every pre-migration row.
--   'internal' our internal Braintree renewal cron bills it (`internal-*` contract ids).
--   'shopcx'   a Shopify contract our app owns; `shopifySubscriptionRenewalCron` bills it.
--
-- ⭐ Deliberately defaulted to 'appstle' and backfilled conservatively: a row that is anything
-- other than provably-internal stays on the vendor path. The dangerous direction here is a
-- subscription that NO engine believes it owns — that bills never, silently, forever — so the
-- default must be the engine that is actually running today.

alter table public.subscriptions
  add column if not exists billing_source text not null default 'appstle';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'subscriptions_billing_source_check'
  ) then
    alter table public.subscriptions
      add constraint subscriptions_billing_source_check
      check (billing_source in ('appstle', 'internal', 'shopcx'));
  end if;
end $$;

-- Backfill: everything already on our internal path.
update public.subscriptions
   set billing_source = 'internal'
 where billing_source <> 'internal'
   and (is_internal = true or shopify_contract_id like 'internal-%');

-- The renewal cron selects on (billing_source, status, next_billing_date).
create index if not exists subscriptions_billing_source_due_idx
  on public.subscriptions (billing_source, status, next_billing_date);

comment on column public.subscriptions.billing_source is
  'Which engine bills this sub: appstle (vendor, default) | internal (Braintree cron) | shopcx (Shopify contract our app owns, billed by shopifySubscriptionRenewalCron). Defaults to appstle so a row is never orphaned into billing-by-nobody.';
