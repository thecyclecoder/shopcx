-- Internal coupons table — our own source of truth for discount codes
-- (will replace Shopify discounts). The coupon engine (src/lib/coupons.ts)
-- resolves a code from here first ("internal wins"), then falls back to a
-- real-time Shopify discount-code lookup. Discounts are entire-order scoped
-- (we ignore Shopify product scope) and stack on subscribe-and-save + the
-- quantity break. The internal renewal scheduler applies them at charge time
-- and consumes recurring_cycle_limit per charge.

create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  code text not null,
  type text not null check (type in ('percentage', 'fixed_amount')),
  value integer not null,                 -- percentage: 0-100 · fixed_amount: cents
  scope text not null default 'order',    -- always 'order'
  recurring_cycle_limit integer,          -- 1 | N | null (forever)
  customer_id uuid references public.customers(id) on delete cascade, -- set => only this customer
  single_use boolean not null default false,
  used_at timestamptz,
  stackable boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One code per workspace (case-insensitive).
create unique index if not exists coupons_workspace_code_idx
  on public.coupons (workspace_id, lower(code));

-- Fast lookup of a customer's minted coupons.
create index if not exists coupons_customer_idx
  on public.coupons (customer_id) where customer_id is not null;
