-- Per-product daily Amazon snapshot (Phase 2 of amazon-per-product-sales-attribution).
-- Sits BESIDE daily_amazon_order_snapshots (the aggregate the ROAS dashboard reads, left untouched):
-- same order lines, but aggregated by (date, asin, bucket) so Amazon sales resolve to product/pack.
--
-- Conservation invariant: for every (snapshot_date, order_bucket),
--   Σ daily_amazon_product_snapshots.gross_revenue_cents = daily_amazon_order_snapshots.gross_revenue_cents
-- Unmapped lines land under product_id = null (asin still recorded) so nothing is lost.
--
-- asin is NOT NULL default '' (sentinel for the rare no-asin line) so the unique key / upsert is stable
-- across re-runs — a NULL asin would defeat onConflict (NULL != NULL) and duplicate rows each sync.
-- See docs/brain/tables/daily_amazon_product_snapshots.md + docs/brain/libraries/amazon__sync-orders.md.

create table if not exists public.daily_amazon_product_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  amazon_connection_id uuid not null references public.amazon_connections(id) on delete cascade,
  snapshot_date date not null,
  asin text not null default '',
  product_id uuid references public.products(id) on delete set null,   -- null = unmapped asin
  pack_size smallint,                                                  -- snapshot of amazon_asins.pack_size
  order_bucket text not null,                                          -- recurring | sns_checkout | one_time
  order_count int not null default 0,
  units int not null default 0,
  gross_revenue_cents int not null default 0,
  net_revenue_cents int not null default 0,
  currency text not null default 'USD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists daily_amazon_product_snapshots_uniq
  on public.daily_amazon_product_snapshots (amazon_connection_id, snapshot_date, asin, order_bucket);

-- Per-product read path (Phase 4 AcqROAS): by product over a date window.
create index if not exists daily_amazon_product_snapshots_product_idx
  on public.daily_amazon_product_snapshots (workspace_id, product_id, snapshot_date);

alter table public.daily_amazon_product_snapshots enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'daily_amazon_product_snapshots' and policyname = 'daily_amazon_product_snapshots_select') then
    create policy daily_amazon_product_snapshots_select on public.daily_amazon_product_snapshots for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'daily_amazon_product_snapshots' and policyname = 'daily_amazon_product_snapshots_service') then
    create policy daily_amazon_product_snapshots_service on public.daily_amazon_product_snapshots for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
