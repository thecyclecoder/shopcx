-- Logistics M2: suppliers + purchase-order annotations.
--
-- `suppliers` stores durable per-manufacturer metadata that QuickBooks doesn't hold well:
-- what kind of partner they are (finished-goods manufacturer vs component printer vs 3PL),
-- a manual lead-time / MOQ override, and notes. The MEASURED lead time + fill rate are still
-- derived live from QB PO->Bill LinkedTxn (src/lib/logistics/lead-times.ts) and joined by
-- qb_vendor_id — this table never duplicates that, it annotates it.
--
-- `purchase_order_annotations` overlays an expected-arrival date on an open PO, because QB
-- leaves PurchaseOrder.DueDate blank. Keyed by the QB PurchaseOrder.Id. This is where the
-- crisis PO's confirmed ETA lives (the measured-lead estimate is only a fallback).
-- Read-only from QB; never writes QuickBooks. See docs/brain/functions/logistics.md.

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  qb_vendor_id text,                              -- QuickBooks Vendor.Id (join key to measured lead times)
  kind text not null default 'manufacturer',      -- 'manufacturer' | 'component' | '3pl' | 'other'
  lead_days_override integer,                      -- manual lead-time override (else use the measured avg)
  min_order_qty integer,                           -- MOQ, when the supplier enforces one
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);
create index if not exists idx_suppliers_ws on public.suppliers(workspace_id);
create unique index if not exists idx_suppliers_ws_vendor on public.suppliers(workspace_id, qb_vendor_id) where qb_vendor_id is not null;

create table if not exists public.purchase_order_annotations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  qb_po_id text not null,                          -- QuickBooks PurchaseOrder.Id
  supplier_id uuid references public.suppliers(id) on delete set null,
  expected_arrival_date date,                      -- OUR ETA (QB DueDate is blank)
  eta_status text,                                 -- 'estimated' | 'confirmed' | 'delayed' | 'received'
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, qb_po_id)
);
create index if not exists idx_po_annotations_ws on public.purchase_order_annotations(workspace_id);

-- RLS: workspace members read; all writes go through the admin client (service role).
alter table public.suppliers enable row level security;
alter table public.purchase_order_annotations enable row level security;
do $$
declare t text;
begin
  foreach t in array array['suppliers','purchase_order_annotations']
  loop
    execute format($f$drop policy if exists %I_member_read on public.%I$f$, t, t);
    execute format($f$
      create policy %I_member_read on public.%I for select to authenticated
        using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
    $f$, t, t);
  end loop;
end $$;
