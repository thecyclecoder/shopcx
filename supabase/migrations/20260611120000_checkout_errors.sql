-- Checkout error log. Captures every error that would STOP a checkout or hurt
-- the customer, across the storefront funnel (client + server), so that at
-- go-live we can answer "why aren't checkouts completing?" with a query instead
-- of guesswork. Client posts to /api/checkout/log-error; the checkout API logs
-- its own server-side failures (tax, Braintree, order insert, validation).

create table if not exists public.checkout_errors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  cart_token text,
  customer_id uuid references public.customers(id) on delete set null,
  anonymous_id text,
  -- Funnel stage the error happened at: 'client_token','tax','braintree_charge',
  -- 'order_insert','validation','otp','tokenize','submit','identify', etc.
  stage text not null,
  side text not null default 'server',         -- 'client' | 'server'
  error_code text,                             -- machine code (e.g. 'cart_not_found')
  error_message text,                          -- human/raw message
  context jsonb not null default '{}'::jsonb,  -- extra detail (amounts, processor codes…)
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists checkout_errors_ws_time_idx on public.checkout_errors (workspace_id, created_at desc);
create index if not exists checkout_errors_cart_idx on public.checkout_errors (cart_token) where cart_token is not null;
create index if not exists checkout_errors_stage_idx on public.checkout_errors (workspace_id, stage, created_at desc);
