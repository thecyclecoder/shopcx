-- CFO / QuickBooks P&L snapshots (first slice of the shoptics→shopcx logistics/finance migration).
-- Two tables:
--   quickbooks_connections — per-workspace QBO OAuth connection (all secrets AES-256-GCM encrypted
--     via src/lib/crypto.ts). Seeded by copying shoptics' live refresh_token/realm_id/app-creds.
--   qb_pnl_snapshots — per-workspace, per-CLOSED-month ProfitAndLoss rollup + full raw report.
--     Only completed months are snapshotted (mid-month QBO P&L is distorted by month-end entries).
-- Owner: docs/brain/functions/cfo.md (Grace). Feeds the CEO north-star scoreboard.
-- Idempotent (IF NOT EXISTS + policy guards + DO blocks).

create table if not exists public.quickbooks_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  realm_id text not null,                       -- QBO Company ID (scopes every API path)
  environment text not null default 'production',
  refresh_token_encrypted text not null,        -- rotates on every refresh; re-encrypt + persist each time
  client_id_encrypted text not null,            -- Intuit app client_id (shared app, stored per-conn for self-containment)
  client_secret_encrypted text not null,        -- Intuit app client_secret
  connected_at timestamptz not null default now(),
  token_rotated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id)
);

alter table public.quickbooks_connections enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='quickbooks_connections' and policyname='qbc_service_role_all') then
    create policy qbc_service_role_all on public.quickbooks_connections for all to service_role using (true) with check (true);
  end if;
end $$;

create table if not exists public.qb_pnl_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  period_month date not null,                   -- first day of the CLOSED month (e.g. 2026-06-01)
  currency text not null default 'USD',
  accounting_method text not null default 'Accrual',
  realm_id text,                                -- QBO company provenance
  -- top-level section rollups (from the ProfitAndLoss report's section Summary rows)
  total_income numeric,
  total_cogs numeric,
  gross_profit numeric,
  total_expenses numeric,
  net_operating_income numeric,
  total_other_income numeric,
  total_other_expenses numeric,
  net_other_income numeric,
  net_income numeric,                            -- GAAP profit as booked (management fee still expensed)
  -- transfer-pricing addback: "82000 Management Fees" (PR entity → TX entity intercompany consulting).
  -- Not a real group cost, so true economic profit adds it back.
  management_fees numeric,                        -- the Management Fees line amount (positive expense)
  adjusted_net_income numeric,                   -- net_income + management_fees — the PRIMARY north-star profit
  raw jsonb not null default '{}'::jsonb,        -- full single-month ProfitAndLoss report (account-level drill-down)
  source text not null default 'quickbooks',
  pulled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, period_month)
);

-- upgrade an already-created table (idempotent) with the addback columns
alter table public.qb_pnl_snapshots add column if not exists management_fees numeric;
alter table public.qb_pnl_snapshots add column if not exists adjusted_net_income numeric;

create index if not exists qb_pnl_snapshots_workspace_month_idx
  on public.qb_pnl_snapshots (workspace_id, period_month desc);

alter table public.qb_pnl_snapshots enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='qb_pnl_snapshots' and policyname='qbpnl_member_select') then
    create policy qbpnl_member_select on public.qb_pnl_snapshots for select to authenticated
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='qb_pnl_snapshots' and policyname='qbpnl_service_role_all') then
    create policy qbpnl_service_role_all on public.qb_pnl_snapshots for all to service_role using (true) with check (true);
  end if;
end $$;
