-- Pre-create attempt marker, closing the lost-response duplicate-contract window.
--
-- `migrated_to_contract_id` is written AFTER `subscriptionContractAtomicCreate` returns, so a
-- create that Shopify committed but whose RESPONSE was lost (timeout, socket reset, non-JSON 200)
-- leaves no trace at all: the run reports `stage:"create"`, the marker is null, and a retry creates
-- a SECOND live contract for the same customer. That is exactly how 35945087149 and 35945054381
-- came to exist on one customer.
--
-- Stamping the attempt BEFORE the call means a retry can tell "never tried" from "tried, outcome
-- unknown" and go look for the contract instead of blindly making another.

alter table public.appstle_contract_snapshots
  add column if not exists migration_attempted_at timestamptz;

create index if not exists appstle_contract_snapshots_attempted_idx
  on public.appstle_contract_snapshots (workspace_id, migration_attempted_at desc)
  where migration_attempted_at is not null and migrated_to_contract_id is null;

comment on column public.appstle_contract_snapshots.migration_attempted_at is
  'Stamped immediately BEFORE subscriptionContractAtomicCreate. Set with migrated_to_contract_id null = a create whose outcome is unknown; the migrator searches the customer''s contracts created after this timestamp rather than creating a second one.';
