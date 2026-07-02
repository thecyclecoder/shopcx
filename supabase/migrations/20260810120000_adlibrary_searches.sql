-- adlibrary_searches: per-workspace, per-keyword last-searched log for the AdLibrary sweep.
-- Phase 1 of docs/brain/specs/adlibrary-search-freshness-gate.md.
--
-- The `creative-finder-daily-cron` calls sweepSeed → searchAds once per seed EVERY day
-- with only ad_key vision-dedup, so a 900-searches/month subscription runs at ~67% on
-- one workspace's seed list even when nothing changes. This table is the freshness
-- ledger the Phase 2 gate reads to skip a seed searched within the window.
--
-- Scope: one row per (workspace_id, keyword). Best-effort telemetry — a failed insert
-- must NEVER fail the sweep (call site swallows errors), so no NOT NULL beyond the
-- identity/scope columns.
--
-- No customer_id column → no Sonnet data tool needed (CLAUDE.md rule for
-- customer-referenced tables does not apply).

create table if not exists public.adlibrary_searches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  keyword text not null,
  -- Wall-clock of the most recent searchAds return for this (workspace, keyword).
  -- NULL is impossible in practice (the writer stamps now()) but the column is
  -- nullable so a manually-seeded "never searched" row is representable.
  last_searched_at timestamptz,
  -- Ads returned by the last searchAds call. NULL when the last search errored.
  last_result_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, keyword)
);

comment on table public.adlibrary_searches is
  'Per-(workspace, keyword) last-searched ledger for the AdLibrary sweep. Written best-effort '
  'from sweepSeed after searchAds returns; read by the Phase 2 freshness gate to skip seeds '
  'searched within the window (default 7d).';

-- Freshness-gate read path: filterSeedsByFreshness selects
--   where workspace_id = ? and last_searched_at > now() - interval '<window>'
-- ORDER BY last_searched_at desc across seeds. The (workspace_id, last_searched_at)
-- composite serves both filter shapes (equality + range).
create index if not exists adlibrary_searches_workspace_last_searched_idx
  on public.adlibrary_searches (workspace_id, last_searched_at);

-- updated_at auto-bump on any UPDATE (mirrors ad_spend_budgets so the ledger
-- stays honest without app-layer help).
create or replace function public.adlibrary_searches_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists adlibrary_searches_touch_updated_at on public.adlibrary_searches;
create trigger adlibrary_searches_touch_updated_at
  before update on public.adlibrary_searches
  for each row execute function public.adlibrary_searches_touch_updated_at();

alter table public.adlibrary_searches enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'adlibrary_searches' and policyname = 'adlibrary_searches_select') then
    create policy adlibrary_searches_select on public.adlibrary_searches for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'adlibrary_searches' and policyname = 'adlibrary_searches_service') then
    create policy adlibrary_searches_service on public.adlibrary_searches for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
