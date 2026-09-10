-- Idempotency marker for the Appstle→ShopCX migration.
--
-- Found the hard way on the first real run: `executeMigration` had no "already done" check, so
-- running it twice for one source contract created TWO live Shopify contracts for the same
-- customer (35945087149 and 35945054381). Nothing billed — `billing_source` was untouched — but at
-- scale that is a double-billing hazard the moment either is activated, and a retry after a
-- transient error is the obvious way to trigger it.
--
-- The marker lives on the snapshot row because that row is already keyed on
-- (workspace_id, appstle_contract_id) — the exact identity being migrated — and already exists
-- for every contract in the population.

alter table public.appstle_contract_snapshots
  add column if not exists migrated_to_contract_id text,
  add column if not exists migrated_at             timestamptz,
  -- Set BEFORE the Appstle cancel so a crashed swap is findable rather than silent. A row with
  -- `migrated_to_contract_id` set but `migration_completed_at` null is a half-finished swap and
  -- must be reconciled, never re-run blind.
  add column if not exists migration_completed_at  timestamptz;

create index if not exists appstle_contract_snapshots_migrated_idx
  on public.appstle_contract_snapshots (workspace_id, migrated_at desc)
  where migrated_to_contract_id is not null;

comment on column public.appstle_contract_snapshots.migrated_to_contract_id is
  'The ShopCX-owned Shopify contract created for this Appstle contract. Presence = already migrated; executeMigration refuses to create a second one.';
