-- Point-in-time snapshots of Appstle subscription contracts, taken so the
-- Appstle→ShopCX migration can be planned and re-planned WITHOUT re-hitting a
-- metered API for every dry run.
--
-- Why a snapshot table rather than reading live each pass:
--   * Appstle bills per API call. ~2,478 contracts migrate; each dry run over
--     live Appstle would be another 2,478 hits. Snapshot once, dry-run free.
--   * Our `subscriptions` mirror CANNOT stand in for it. Verified 2026-09-10:
--     `subscriptions.items[].price_cents` mirrors Appstle's `currentPrice` —
--     the price BEFORE discount allocations — so a contract with an allocation
--     reads ~$7.50/unit too high. The migration prices off
--     `lineDiscountedPrice / quantity`, which the mirror does not carry at all.
--     The mirror also loses SKUs the source does have.
--
-- `raw` is the authoritative column: the untouched Appstle response. The typed
-- columns are a convenience projection and may be re-derived from `raw` at any
-- time without another API call. Never treat a typed column as the source when
-- `raw` disagrees.
--
-- A snapshot is NOT a substitute for a read-at-write-time. The migrator re-reads
-- the single contract it is about to move and aborts if it drifted since the
-- snapshot; this table drives PLANNING, never the write itself.

create table if not exists public.appstle_contract_snapshots (
  id                        uuid primary key default gen_random_uuid(),
  workspace_id              uuid not null references public.workspaces(id) on delete cascade,
  -- The Shopify subscription contract id Appstle manages (bare numeric, as Appstle returns it).
  appstle_contract_id       text not null,
  -- Our mirror row, when we have one. Null means Appstle knows a contract we do not.
  subscription_id           uuid references public.subscriptions(id) on delete set null,

  status                    text,
  next_billing_date         timestamptz,
  billing_interval          text,
  billing_interval_count    integer,
  delivery_price_cents      integer,

  -- CustomerPaymentMethod gid + whether it is still usable. A revoked or absent
  -- method means the contract cannot be recreated under our app at all.
  payment_method_id         text,
  payment_method_revoked    boolean,
  payment_method_type       text,

  delivery_method           jsonb,
  -- Normalized lines: sku, variant_id, quantity, current_price_cents,
  -- discounted_total_cents, selling_plan_name, discount_allocation_count.
  lines                     jsonb not null default '[]',

  -- The untouched Appstle response. Authoritative.
  raw                       jsonb,
  -- Set when the fetch failed; `raw` is then null and the row records the miss
  -- rather than silently not existing (a missing row is indistinguishable from
  -- "never attempted", which is the failure mode this column closes).
  fetch_error               text,
  fetched_at                timestamptz not null default now(),
  created_at                timestamptz not null default now(),

  unique (workspace_id, appstle_contract_id)
);

create index if not exists appstle_contract_snapshots_ws_fetched_idx
  on public.appstle_contract_snapshots (workspace_id, fetched_at desc);
create index if not exists appstle_contract_snapshots_sub_idx
  on public.appstle_contract_snapshots (workspace_id, subscription_id);
create index if not exists appstle_contract_snapshots_error_idx
  on public.appstle_contract_snapshots (workspace_id)
  where fetch_error is not null;

alter table public.appstle_contract_snapshots enable row level security;

drop policy if exists appstle_contract_snapshots_select on public.appstle_contract_snapshots;
create policy appstle_contract_snapshots_select
  on public.appstle_contract_snapshots for select
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

comment on table public.appstle_contract_snapshots is
  'Point-in-time Appstle contract snapshots for migration planning. `raw` is authoritative; typed columns are a re-derivable projection. Exists because Appstle is metered per call and because subscriptions.items[].price_cents mirrors currentPrice (pre-discount-allocation), not what the customer actually pays.';
