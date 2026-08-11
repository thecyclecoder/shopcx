-- Shoptics→ShopCX close CUTOVER, Phase 1: the SOURCE-DATA layer the month-end close consumes.
--
-- The qb-close engine (src/lib/qb-close/*) and the qb_* MAPPING tables are already on main,
-- but ShopCX holds none of the per-day source data the close actually reads — the June 1:1
-- proof ran entirely off `fixtures/shoptics-golden/*.json` dumped out of the Shoptics DB, so
-- the gap was invisible until the July dry run. These 8 tables close it.
--
-- Naming: every table is `qb_`-prefixed, grouping it with the existing qb_* family and
-- avoiding a collision with ShopCX's OWN `public.inventory_snapshots` (a different thing —
-- location/on_hand/inbound per SKU-day, feeding logistics, not the books).
--
-- Product identity is `qb_items(id)` (the QuickBooks item catalog), NOT `public.products` —
-- same convention `qb_manual_inventory` already uses. Internal joins are UUIDs per CLAUDE.md.
--
-- Shapes mirror the Shoptics originals column-for-column (introspected from the live Shoptics
-- DB 2026-08-11) so the ported builders read them unchanged, plus `workspace_id` for tenancy.
-- See docs/brain/lifecycles/shoptics-migration.md.

-- ── Amazon sales, per ASIN per day (drives the Amazon sales receipt + audit burn) ──
create table if not exists public.qb_amazon_sales_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  asin text not null,
  seller_sku text,
  product_name text,
  sale_date date not null,
  units_shipped integer not null default 0,
  revenue numeric(14,2) not null default 0,
  units_pending integer not null default 0,
  units_cancelled integer not null default 0,
  recurring_units integer not null default 0,
  recurring_revenue numeric(14,2) not null default 0,
  sns_checkout_units integer not null default 0,
  sns_checkout_revenue numeric(14,2) not null default 0,
  one_time_units integer not null default 0,
  one_time_revenue numeric(14,2) not null default 0,
  snapshot_taken_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (workspace_id, asin, sale_date)
);
create index if not exists idx_qb_amz_sales_ws_date on public.qb_amazon_sales_snapshots(workspace_id, sale_date);

-- ── Shopify sales, per `${product_id}-${variant_id}` per day ──
-- `units_sold` EXCLUDES fully-refunded orders; those units land in `refund_units`. Inventory
-- burn and COGS must use units_sold + refund_units — a refunded unit still shipped and is not
-- guaranteed restockable (CEO 2026-08-11). Revenue-facing readers may use units_sold alone.
create table if not exists public.qb_shopify_sales_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  variant_id text not null,                       -- composite `${product_id}-${variant_id}`, load-bearing
  sku text,
  product_name text,
  sale_date date not null,
  units_sold integer not null default 0,
  revenue numeric(14,2) not null default 0,
  recurring_units integer not null default 0,
  recurring_revenue numeric(14,2) not null default 0,
  first_sub_units integer not null default 0,
  first_sub_revenue numeric(14,2) not null default 0,
  one_time_units integer not null default 0,
  one_time_revenue numeric(14,2) not null default 0,
  refund_units integer not null default 0,
  refund_amount numeric(14,2) not null default 0,
  snapshot_taken_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (workspace_id, variant_id, sale_date)
);
create index if not exists idx_qb_shop_sales_ws_date on public.qb_shopify_sales_snapshots(workspace_id, sale_date);

-- ── Internal (ShopCX-native) sales, per order line ──
-- Order-level money (order_total/discount/tax/shipping) is carried ONLY on line_index 0 so an
-- order is counted once; gross_cents is per line. The JE relies on
-- order_total == gross - discount + tax + shipping; a dropped line breaks the JE balance.
create table if not exists public.qb_internal_sales_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  order_number text,
  line_index integer not null default 0,
  sale_date date not null,
  source_name text,
  financial_status text,
  processor text,
  sku text,
  variant_id text,
  product_id uuid references public.qb_items(id) on delete set null,
  units numeric(12,2) not null default 0,
  gross_cents integer not null default 0,
  order_total_cents integer not null default 0,
  discount_cents integer not null default 0,
  tax_cents integer not null default 0,
  shipping_cents integer not null default 0,
  raw_payload jsonb,
  snapshot_taken_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (order_id, line_index)
);
create index if not exists idx_qb_int_sales_ws_date on public.qb_internal_sales_snapshots(workspace_id, sale_date);

-- ── FBA inventory, per ASIN per day ──
-- INVARIANT (verified across 3,240 rows, 2026-06-01→08-11): quantity_transit ==
-- inboundWorking + quantity_inbound + quantity_reserved. Physical = fulfillable + transit
-- ONLY. Adding reserved or inbound on top DOUBLE-COUNTS.
create table if not exists public.qb_amazon_inventory_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  asin text not null,
  seller_sku text,
  fn_sku text,
  quantity_fulfillable integer not null default 0,
  quantity_inbound integer not null default 0,
  quantity_reserved integer not null default 0,
  quantity_transit integer not null default 0,
  snapshot_date date not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, asin, snapshot_date)
);
create index if not exists idx_qb_amz_inv_ws_date on public.qb_amazon_inventory_snapshots(workspace_id, snapshot_date);

-- ── 3PL (Amplifier) inventory, per SKU per day ──
-- Use quantity_on_hand, NOT quantity_available: `available` nets off units COMMITTED to
-- orders the 3PL has not yet shipped, which are still on the shelf and still ours at the
-- cutoff. Reading `available` booked owned stock as shrinkage (July 2026: +1,701 unit swing).
create table if not exists public.qb_tpl_inventory_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  sku text not null,
  name text,
  quantity_on_hand integer not null default 0,
  quantity_available integer not null default 0,
  quantity_committed integer not null default 0,
  quantity_expected integer not null default 0,
  snapshot_date date not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, sku, snapshot_date)
);
create index if not exists idx_qb_tpl_inv_ws_date on public.qb_tpl_inventory_snapshots(workspace_id, snapshot_date);

-- ── Processor month rollups (the JE's fees / refunds / chargebacks / clearing block) ──
create table if not exists public.qb_payment_processor_summaries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  closing_month text not null,                    -- 'YYYY-MM'
  processor text not null,                        -- shopify_payments | paypal | braintree
  gross_sales numeric(14,2) not null default 0,
  processing_fees numeric(14,2) not null default 0,
  refunds numeric(14,2) not null default 0,
  chargebacks numeric(14,2) not null default 0,
  adjustments numeric(14,2) not null default 0,
  net_deposits numeric(14,2) not null default 0,
  raw_payload jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (workspace_id, closing_month, processor)
);

-- ── QB BOOK inventory snapshot (steps 1 + 6): what QuickBooks itself held, pre/post close ──
-- The post-close row for month M is the OPENING BOOK for month M+1 — `qb_starting` in the
-- audit. Distinct from public.inventory_snapshots (ShopCX's physical/logistics view).
create table if not exists public.qb_book_inventory_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null references public.qb_items(id) on delete cascade,
  source text not null default 'quickbooks',
  quantity numeric(14,2) not null default 0,
  snapshot_type text,                             -- 'month_end_pre' | 'month_end_post'
  closing_month text,                             -- 'YYYY-MM' the snapshot belongs to
  snapshot_at timestamptz not null default now(),
  raw_payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_qb_book_inv_lookup
  on public.qb_book_inventory_snapshots(workspace_id, closing_month, snapshot_type);

-- ── The close ledger. `closing_month` is UNIQUE per workspace — the run-once guard. ──
create table if not exists public.qb_month_end_closings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  closing_month text not null,                    -- 'YYYY-MM'
  status text not null default 'running',         -- running | completed | completed_with_errors | error
  pre_snapshot_at timestamptz,
  post_snapshot_at timestamptz,
  inventory_adjustment_id text,
  amazon_receipt_id text,
  amazon_receipt_doc text,
  shopify_receipt_id text,
  shopify_receipt_doc text,
  internal_receipt_id text,
  internal_receipt_doc text,
  shopify_journal_entry_id text,
  shopify_journal_entry_doc text,
  variance_check_passed boolean,
  variance_details jsonb,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, closing_month)
);

-- RLS: workspace members read; all writes go through createAdminClient() (service role).
do $$
declare t text;
begin
  foreach t in array array[
    'qb_amazon_sales_snapshots','qb_shopify_sales_snapshots','qb_internal_sales_snapshots',
    'qb_amazon_inventory_snapshots','qb_tpl_inventory_snapshots','qb_payment_processor_summaries',
    'qb_book_inventory_snapshots','qb_month_end_closings'
  ]
  loop
    execute format($f$alter table public.%I enable row level security$f$, t);
    execute format($f$drop policy if exists %I_member_read on public.%I$f$, t, t);
    execute format($f$
      create policy %I_member_read on public.%I for select to authenticated
        using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
    $f$, t, t);
  end loop;
end $$;
