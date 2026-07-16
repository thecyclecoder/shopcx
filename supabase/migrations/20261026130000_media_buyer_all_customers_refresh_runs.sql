-- media_buyer_all_customers_refresh_runs — one row per successful weekly refresh
-- of the CUSTOMER_LIST (all-customers, hashed) exclusion audience per
-- (workspace, ad_account, audience). Carries the watermark the NEXT run reads
-- to select only new-since-last-refresh customers, so the incremental upload
-- never sends the whole customer base twice.
-- (bianca-full-order-history-customer-list-exclusion-audience Fix 1.)
--
-- Idempotent (re-run = no-op). RLS: service-role full access + workspace-member
-- SELECT — mirrors sibling media-buyer refresh-ledger tables.

create table if not exists public.media_buyer_all_customers_refresh_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid references public.meta_ad_accounts(id) on delete set null,
  audience_id text not null,
  watermark_at timestamptz not null,
  completed_at timestamptz not null default now(),
  new_customers integer not null default 0,
  uploaded_rows integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists media_buyer_all_customers_refresh_runs_ws_audience_completed_at_idx
  on public.media_buyer_all_customers_refresh_runs (workspace_id, audience_id, completed_at desc);

alter table public.media_buyer_all_customers_refresh_runs enable row level security;

drop policy if exists svc_all
  on public.media_buyer_all_customers_refresh_runs;
create policy svc_all
  on public.media_buyer_all_customers_refresh_runs
  as permissive
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists ws_member_read
  on public.media_buyer_all_customers_refresh_runs;
create policy ws_member_read
  on public.media_buyer_all_customers_refresh_runs
  as permissive
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.workspace_members m
      where m.workspace_id = media_buyer_all_customers_refresh_runs.workspace_id
        and m.user_id = auth.uid()
    )
  );
