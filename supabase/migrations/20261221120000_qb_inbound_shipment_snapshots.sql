-- qb_inbound_shipment_snapshots — the CLOSE'S THIRD PHYSICAL BUCKET.
--
-- Why this table exists. Period-end physical was FBA (fulfillable + Amazon's own inbound) plus
-- the 3PL's on-hand. Units that have LEFT the 3PL on an FBA replenishment but that Amazon has
-- not yet checked in are counted by NEITHER: Amplifier has already decremented them and
-- /fba/inventory/v1/summaries reports nothing until receiving starts.
--
-- August 2026 is the ground-truth case. One consolidated shipment left Amplifier on 08-15 and
-- Amazon checked it in on 09-01 — 17 days spanning the 08-31 cutoff. 1,050 units across 11 ASINs
-- were invisible on the close date, and the audit booked them as shrinkage: the inventory
-- adjustment came to $12,607.56 against a $2,376.66 recent maximum and tripped
-- `adjustment_implausible`. Every variance >= 100 units carried this signature; every variance
-- < 100 carried none.
--
-- ⭐ A dated in-transit position CANNOT be reconstructed later — the same rule that already forces
-- the daily FBA/3PL snapshots. `QuantityShipped - QuantityReceived` is a point-in-time value: once
-- Amazon finishes receiving, the shipment reads fully received and thehistorical position is gone. This
-- is why the sync is a daily cron and not something the close computes at run time.
--
-- See docs/brain/tables/qb_inbound_shipment_snapshots.md.

create table if not exists public.qb_inbound_shipment_snapshots (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  snapshot_date     date not null,
  shipment_id       text not null,
  shipment_name     text,
  shipment_status   text,
  seller_sku        text not null,
  asin              text,
  quantity_shipped  integer not null default 0,
  quantity_received integer not null default 0,
  -- Units that have left the origin and are not yet on Amazon's books. Never negative: Amazon can
  -- receive MORE than was declared shipped (August had a +21 over-receipt on ST-DETOX-4), and a
  -- negative would silently subtract real stock from the close's physical total.
  in_transit        integer not null default 0,
  snapshot_taken_at timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  constraint qb_inbound_shipment_snapshots_uniq unique (workspace_id, snapshot_date, shipment_id, seller_sku)
);

create index if not exists qb_inbound_shipment_snapshots_ws_date_idx
  on public.qb_inbound_shipment_snapshots (workspace_id, snapshot_date);
create index if not exists qb_inbound_shipment_snapshots_ws_date_asin_idx
  on public.qb_inbound_shipment_snapshots (workspace_id, snapshot_date, asin);

alter table public.qb_inbound_shipment_snapshots enable row level security;

drop policy if exists qb_inbound_shipment_snapshots_select on public.qb_inbound_shipment_snapshots;
create policy qb_inbound_shipment_snapshots_select
  on public.qb_inbound_shipment_snapshots for select
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

comment on table public.qb_inbound_shipment_snapshots is
  'Daily point-in-time FBA inbound position: units shipped to Amazon but not yet received. The close''s third physical bucket, alongside qb_amazon_inventory_snapshots and qb_tpl_inventory_snapshots. Cannot be reconstructed after the fact.';
comment on column public.qb_inbound_shipment_snapshots.in_transit is
  'max(0, quantity_shipped - quantity_received) on the snapshot date. Floored at zero — Amazon can over-receive.';
