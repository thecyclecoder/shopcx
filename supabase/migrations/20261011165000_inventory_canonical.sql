-- Canonical inventory source of truth (Logistics). Unifies on-hand across every
-- channel/location into ONE model, replacing the fragmented pair of stores ShopCX
-- has today (fresh Shopify JSONB in products.variants[] + a stale, backfill-only
-- product_variants.inventory_quantity column). Neither of those has FBA / 3PL / manual;
-- this does. Stores RAW quantities as each source reports them — the finished-good
-- rollup with case-pack multipliers lives in the read layer (qb_sku_mappings, already
-- reconciled). See docs/brain/functions/logistics.md § single source of truth.

-- ── Current levels — the fast read path + single source of truth ──
create table if not exists public.inventory_levels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  location text not null,                    -- 'shopify' | 'fba' | 'amplifier_3pl' | 'manual'
  external_ref text not null,                -- the channel's native key: asin | 3pl sku | shopify variant gid | manual key
  sku text,                                  -- resolved SKU (nullable until resolved)
  product_id uuid references public.products(id) on delete set null,  -- resolved product (nullable)
  variant_id text,                           -- shopify variant gid, when applicable
  on_hand integer not null default 0,        -- fulfillable / available, RAW as the source reports it
  inbound integer not null default 0,        -- inbound / in-transit (FBA); 0 for sources without it
  reserved integer,                          -- optional (FBA reserved), nullable
  source_synced_at timestamptz,              -- when the source last reported this level
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, location, external_ref)
);
create index if not exists idx_inventory_levels_ws on public.inventory_levels(workspace_id);
create index if not exists idx_inventory_levels_product on public.inventory_levels(workspace_id, product_id);
create index if not exists idx_inventory_levels_sku on public.inventory_levels(workspace_id, sku);

-- ── Dated history — days-of-cover trend + the month-end close inventory audit ──
create table if not exists public.inventory_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  location text not null,
  external_ref text not null,
  sku text,
  product_id uuid references public.products(id) on delete set null,
  on_hand integer not null default 0,
  inbound integer not null default 0,
  snapshot_date date not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, location, external_ref, snapshot_date)
);
create index if not exists idx_inventory_snapshots_ws_date on public.inventory_snapshots(workspace_id, snapshot_date);
create index if not exists idx_inventory_snapshots_product on public.inventory_snapshots(workspace_id, product_id, snapshot_date);

-- RLS: workspace members read; all writes go through the admin client (service role).
alter table public.inventory_levels enable row level security;
alter table public.inventory_snapshots enable row level security;
do $$
declare t text;
begin
  foreach t in array array['inventory_levels','inventory_snapshots']
  loop
    execute format($f$drop policy if exists %I_member_read on public.%I$f$, t, t);
    execute format($f$
      create policy %I_member_read on public.%I for select to authenticated
        using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
    $f$, t, t);
  end loop;
end $$;
