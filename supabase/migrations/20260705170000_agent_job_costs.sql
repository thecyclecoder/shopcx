-- agent_job_costs: per-job, per-turn token metering for the box agent fleet
-- (the `claude -p` lanes — build / plan / fold / spec-chat / repair / regression /
-- triage / spec-test / migration-fix / …). These run on the Max subscription with
-- NO ANTHROPIC_API_KEY, so they write nothing to ai_token_usage and there is no
-- per-token dollar bill. The honest proxy is TOKEN usage (the `claude -p` result
-- event reports it) plus the MAX ACCOUNT / config-dir that burned the 5-hour window.
-- One job can span resumes / multiple turns → MULTIPLE cost rows per job_id that
-- aggregate. See docs/brain/specs/fleet-cost-metering.md + docs/brain/tables/agent_job_costs.md.

create table if not exists public.agent_job_costs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.agent_jobs(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  spec_slug text,
  kind text,
  owner_function text,                                    -- org-chart function (ownerFunctionForKind), best-effort
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_creation_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  model text,
  -- Phase 2: which Max account / CLAUDE_CONFIG_DIR ran this turn — the subscription
  -- usage-window attribution for the no-ANTHROPIC_API_KEY lanes.
  account text,
  config_dir text,
  -- Dollar cost in cents — ONLY for genuinely API-billed rows (usageCostCents). Max-lane
  -- rows leave this NULL: a subscription has no per-token bill, never a fabricated $.
  usage_cost_cents numeric,
  created_at timestamptz not null default now()
);

create index if not exists agent_job_costs_job_idx on public.agent_job_costs (job_id);
create index if not exists agent_job_costs_ws_created_idx on public.agent_job_costs (workspace_id, created_at desc);
create index if not exists agent_job_costs_slug_idx on public.agent_job_costs (spec_slug, created_at desc);
create index if not exists agent_job_costs_kind_idx on public.agent_job_costs (kind, created_at desc);
create index if not exists agent_job_costs_owner_idx on public.agent_job_costs (owner_function, created_at desc);

alter table public.agent_job_costs enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'agent_job_costs' and policyname = 'agent_job_costs_select') then
    create policy agent_job_costs_select on public.agent_job_costs for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'agent_job_costs' and policyname = 'agent_job_costs_service') then
    create policy agent_job_costs_service on public.agent_job_costs for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
