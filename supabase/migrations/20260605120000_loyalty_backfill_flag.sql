-- Add a flag we can set when we know a member is owed points for orders
-- that landed before/while the earn pipeline was missing. Set during the
-- one-shot audit; cleared by the points-backfill script after it credits.

alter table public.loyalty_members
  add column if not exists needs_points_backfill boolean not null default false;

create index if not exists idx_loyalty_members_needs_backfill
  on public.loyalty_members (workspace_id)
  where needs_points_backfill = true;
