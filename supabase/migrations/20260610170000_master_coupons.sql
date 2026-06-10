-- Master coupons + derived per-customer codes (no row-per-issued-coupon).
--
-- A MASTER coupon (is_master=true) defines the terms once. Per-customer codes
-- are VIRTUAL: "{master.code}-{customers.short_code}" (e.g. WELCOME-GSXN), where
-- short_code is the same permanent per-customer code already used for SMS
-- shortlinks. resolveCoupon() splits on the last hyphen, matches the master by
-- prefix, resolves the suffix → customer via customers.short_code, and binds the
-- redemption to that customer. Single-use is enforced by the coupon_redemptions
-- ledger (a row written ONLY on actual redemption) — so we never pre-generate
-- thousands of coupon rows before an SMS blast: the campaign code is appended to
-- each recipient's short_code at send time, and a redemption row appears only if
-- they actually use it.
--
-- Redemption policy lives on the master:
--   per_customer_limit          — max redemptions per customer within the cycle
--   reissuable                  — whether a campaign can reset the cycle
--   redemption_cycle_started_at — redemptions before this are ignored; re-issuing
--                                 a campaign bumps it to now() so eligible again
--   valid_until                 — offer expiry (null = none)
-- WELCOME = one-per-customer-FOREVER → cycle start at the epoch, not reissuable.
-- A campaign (VIPSALE / WEEKEND) = reissuable=true, cycle bumped each launch.

alter table public.coupons
  add column if not exists is_master boolean not null default false,
  add column if not exists per_customer_limit integer,
  add column if not exists reissuable boolean not null default false,
  add column if not exists redemption_cycle_started_at timestamptz,
  add column if not exists valid_until timestamptz;

-- Redemption ledger — one row per ACTUAL redemption (not per issuance). Doubles
-- as redemption analytics. coupon_id points at the master (derived codes) or the
-- explicit coupon row (legacy one-offs that opt into the ledger).
create table if not exists public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  derived_code text not null,                                          -- the actual code used (WELCOME-GSXN)
  order_id uuid references public.orders(id) on delete set null,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  redeemed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- The eligibility query: count(*) where coupon_id + customer_id + redeemed_at >= cycle.
create index if not exists coupon_redemptions_lookup_idx
  on public.coupon_redemptions (coupon_id, customer_id, redeemed_at);
create index if not exists coupon_redemptions_customer_idx
  on public.coupon_redemptions (workspace_id, customer_id);

-- Seed the WELCOME master for Superfoods: 15% off, first charge only
-- (recurring_cycle_limit=1), one per customer forever (cycle start = epoch,
-- not reissuable, per_customer_limit=1). Idempotent.
insert into public.coupons
  (workspace_id, code, type, value, scope, recurring_cycle_limit,
   is_master, per_customer_limit, reissuable, redemption_cycle_started_at)
select
  'fdc11e10-b89f-4989-8b73-ed6526c4d906', 'WELCOME', 'percentage', 15, 'order', 1,
  true, 1, false, '1970-01-01T00:00:00Z'
where not exists (
  select 1 from public.coupons
  where workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906' and lower(code) = 'welcome'
);
