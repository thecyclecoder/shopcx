-- migrate-to-internal.ts flips an Appstle sub to internal by RENAMING its
-- shopify_contract_id (numeric → internal-…). That rename is what stops a stale
-- Appstle webhook from clobbering the migrated row — but it also means the
-- Appstle "subscription.cancelled" webhook that fires from the migration's own
-- cancel step arrives with the OLD numeric id and can no longer find the row, so
-- the webhook handler INSERTS a fresh dead cancelled row carrying that old id.
-- The portal's resolveSub then resolves a customer's stale numeric id to that
-- dead shell instead of their live internal sub (false "out of stock").
--
-- Fix: retain the original contract id on the migrated row so both the webhook
-- guard and resolveSub can map the old id back to the live internal sub.
alter table public.subscriptions
  add column if not exists migrated_from_contract_id text;

comment on column public.subscriptions.migrated_from_contract_id is
  'For subs flipped to internal by migrate-to-internal.ts: the original Appstle/Shopify numeric contract id, retained so a stale Appstle cancel webhook (webhooks/appstle guard) and portal lookups (portal/helpers.resolveSub) resolve the old id to this migrated row rather than creating/finding a dead cancelled shell. NULL for never-migrated subs.';

-- Partial index: the guard + resolveSub look up by (workspace_id, migrated_from_contract_id)
-- only for the small set of migrated subs; skip the NULL majority.
create index if not exists idx_subscriptions_migrated_from_contract_id
  on public.subscriptions (workspace_id, migrated_from_contract_id)
  where migrated_from_contract_id is not null;
