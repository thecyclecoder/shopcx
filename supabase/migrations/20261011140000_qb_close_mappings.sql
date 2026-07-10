-- Shoptics → ShopCX migration, Phase 1: the crown-jewel mapping/config tables.
-- Workspace-scoped ports of Shoptics' product/account/Amazon mapping layer, owned
-- by Logistics (Marco) + CFO (Grace). Shoptics' own UUIDs are preserved on copy so
-- every FK (sku_mappings.product_id, item_bom parents, etc.) stays valid with no
-- remapping. Namespaced `qb_*` to avoid colliding with ShopCX's first-class
-- `products` table (a different concept). See docs/brain/lifecycles/shoptics-migration.md.

-- ── QB item catalog (Shoptics `products`: QuickBooks Items — inventory + Group/bundle) ──
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

-- ── Account mappings (semantic key → QuickBooks account/customer id) ──
create table if not exists public.qb_account_mappings (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  key text not null,
  qb_id text not null,
  qb_name text not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, key)
);

-- ── Shopify gateway → processor category ──
create table if not exists public.qb_gateway_mappings (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  gateway_name text not null,
  processor text not null,                               -- shopify_payments|paypal|braintree|gift_card|walmart|other
  primary key (workspace_id, gateway_name)
);

-- ── Shipping-protection Shopify product ids (revenue reclassified as shipping income) ──
create table if not exists public.qb_shipping_protection_products (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  shopify_product_id text not null,
  title text,
  created_at timestamptz not null default now(),
  primary key (workspace_id, shopify_product_id)
);

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

-- RLS: workspace members read; service role does everything (all writes go through admin client).
alter table public.qb_items enable row level security;
alter table public.qb_item_bom enable row level security;
alter table public.qb_sku_mappings enable row level security;
alter table public.qb_external_skus enable row level security;
alter table public.qb_account_mappings enable row level security;
alter table public.qb_gateway_mappings enable row level security;
alter table public.qb_shipping_protection_products enable row level security;
alter table public.qb_manual_inventory enable row level security;

do $$
declare t text;
begin
  foreach t in array array['qb_items','qb_item_bom','qb_sku_mappings','qb_external_skus','qb_account_mappings','qb_gateway_mappings','qb_shipping_protection_products','qb_manual_inventory']
  loop
    execute format($f$
      create policy %I_member_read on public.%I for select to authenticated
        using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
    $f$, t, t);
  end loop;
end $$;
