-- Comp subscriptions (employee / influencer / investor / owner): an internal sub
-- that ships free on schedule — base $0, no PM, no charge — only when its customer
-- is on the comp allowlist (non-null comp_role). See docs/brain/specs/comp-subscriptions.md.
--
-- Two markers:
--   customers.comp_role  — the allowlist + role (null = NOT comp-eligible). Setting it
--                          adds the customer to the allowlist (owner/admin only).
--   customers.comp_note  — free-text reason ("employee", "creator @x", …).
--   subscriptions.comp   — this sub ships free (paired with item price_override_cents=0).
--   subscriptions.comp_note — free-text reason on the sub.
--
-- The renewal path fails CLOSED: a comp sub whose customer has a null/invalid comp_role
-- does NOT ship — it records a failed `comp` transaction + customer_event instead.

-- Role enum for the comp allowlist.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'comp_role') then
    create type public.comp_role as enum ('employee', 'influencer', 'investor', 'owner');
  end if;
end$$;

alter table public.customers
  add column if not exists comp_role public.comp_role,        -- null = not comp-eligible (the allowlist gate)
  add column if not exists comp_note text;

alter table public.subscriptions
  add column if not exists comp boolean not null default false,
  add column if not exists comp_note text;

-- Partial index for the Customers → Comp Subscriptions list view (every comp=true sub).
create index if not exists idx_subscriptions_comp
  on public.subscriptions (workspace_id)
  where comp = true;

-- Partial index for the allowlist roster (customers with a role set).
create index if not exists idx_customers_comp_role
  on public.customers (workspace_id, comp_role)
  where comp_role is not null;
