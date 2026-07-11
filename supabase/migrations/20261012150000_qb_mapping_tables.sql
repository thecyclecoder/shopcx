-- Backfill: the 5 QB mapping tables' creating migration.
--
-- These tables were created by raw SQL during the Shoptics→ShopCX migration
-- ("port crown-jewel mappings" step) but their `create table` was never committed
-- to a migration file on main. src/lib/logistics/* (cover.ts, replenishment-data.ts,
-- crisis-forecast.ts) reads them via `.from(...)`, so `check:table-refs-have-migrations`
-- fails on main with no creating migration — halting the box build pipeline. This file
-- recomposes that DDL verbatim from the live prod schema (introspected + matched exactly:
-- 19/6/10/16/9 columns). `if not exists` everywhere → a no-op against prod (already live)
-- and correct for a fresh DB. The remaining qb_* tables (qb_account_mappings /
-- qb_gateway_mappings / qb_shipping_protection_products) land with the qb-close engine
-- when that (still-unmerged) branch merges — they aren't referenced by main's code yet.
-- See docs/brain/lifecycles/shoptics-migration.md.

-- ── QB item catalog (QuickBooks Items — inventory + Group/bundle) ──
create table if not exists public.qb_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  quickbooks_id text not null,
  quickbooks_name text not null,
  sku text,
  category text,
  unit_cost numeric(12,4),
  reorder_point integer,
  lead_time_days integer,
  active boolean default true,
  item_type text not null default 'inventory',          -- 'inventory' | 'bundle'
  bundle_id uuid,                                        -- legacy single-parent BOM
  bundle_quantity integer,
  product_category text,                                 -- 'finished_good' | 'component' | null
  revenue_account_id text,                               -- account-mapping link (JE revenue)
  revenue_account_name text,
  image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, quickbooks_id)
);
create index if not exists idx_qb_items_ws on public.qb_items(workspace_id);

-- ── Multi-parent BOM (source of truth over legacy bundle_id) ──
create table if not exists public.qb_item_bom (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  parent_id uuid not null references public.qb_items(id) on delete cascade,
  component_id uuid not null references public.qb_items(id) on delete cascade,
  quantity numeric(10,4) not null default 1,
  created_at timestamptz not null default now(),
  unique (workspace_id, parent_id, component_id)
);
create index if not exists idx_qb_item_bom_ws on public.qb_item_bom(workspace_id);

-- ── SKU mappings (external id + source → qb_item) — THE product resolver ──
create table if not exists public.qb_sku_mappings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null references public.qb_items(id) on delete cascade,
  external_id text not null,
  source text not null,                                  -- 'amazon' | '3pl' | 'shopify' | 'manual'
  label text,
  unit_multiplier integer not null default 1,            -- multi-pack factor
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, external_id, source)
);
create index if not exists idx_qb_sku_mappings_ws on public.qb_sku_mappings(workspace_id);
create index if not exists idx_qb_sku_mappings_resolve on public.qb_sku_mappings(workspace_id, external_id, source) where active;

-- ── External SKU cache (drives mapping UI + the Amazon seller_sku→ASIN hop) ──
create table if not exists public.qb_external_skus (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  external_id text not null,
  source text not null,
  label text,
  title text,
  image_url text,
  price numeric(12,4),
  parent_asin text,
  item_type text,                                        -- 'child'|'standalone'|'parent'|'unknown'
  quantity integer,
  seller_sku text,
  status text default 'active',                          -- 'active'|'dismissed'|'discontinued'
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, external_id, source)
);
create index if not exists idx_qb_external_skus_ws on public.qb_external_skus(workspace_id);
create index if not exists idx_qb_external_skus_seller on public.qb_external_skus(workspace_id, seller_sku);

-- ── Manual inventory (components at co-manufacturers) ──
create table if not exists public.qb_manual_inventory (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid references public.qb_items(id) on delete cascade,
  quantity integer,
  location text,
  note text,
  active boolean default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_qb_manual_inventory_ws on public.qb_manual_inventory(workspace_id);

-- RLS: workspace members read; all writes go through the admin client (service role).
alter table public.qb_items enable row level security;
alter table public.qb_item_bom enable row level security;
alter table public.qb_sku_mappings enable row level security;
alter table public.qb_external_skus enable row level security;
alter table public.qb_manual_inventory enable row level security;
do $$
declare t text;
begin
  foreach t in array array['qb_items','qb_item_bom','qb_sku_mappings','qb_external_skus','qb_manual_inventory']
  loop
    execute format($f$drop policy if exists %I_member_read on public.%I$f$, t, t);
    execute format($f$
      create policy %I_member_read on public.%I for select to authenticated
        using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
    $f$, t, t);
  end loop;
end $$;
