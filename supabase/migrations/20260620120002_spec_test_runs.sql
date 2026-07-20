-- spec_test_runs — the box spec-test agent's QA report over shipped-but-not-archived specs.
-- One row per run of a kind='spec-test' agent_jobs job (see scripts/builder-worker.ts → runSpecTestJob).
-- Latest run per (workspace_id, spec_slug) wins on the Developer → Spec Tests page + roadmap board chip.
-- The agent NEVER marks a spec verified/archived (owner-only gate) and NEVER runs a mutating check;
-- it stamps an `agent_verdict` (its own bounded "automatable checks pass" proxy) for the owner to confirm.
-- See docs/brain/specs/spec-test-agent.md + docs/brain/tables/spec_test_runs.md.
create table if not exists public.spec_test_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  spec_slug text not null,
  agent_job_id uuid references public.agent_jobs(id) on delete set null,
  -- approved = zero auto-checks failed · issues = an auto-check failed · needs_human = only human checks remain
  agent_verdict text not null default 'needs_human',
  -- { auto_pass, auto_fail, needs_human, inconclusive } counts
  summary jsonb not null default '{}'::jsonb,
  -- [{ text, verdict: pass|fail|needs_human|inconclusive, category, evidence }]
  checks jsonb not null default '[]'::jsonb,
  transcript text,
  error text,
  run_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Latest run per spec is the common read (Developer page, board chip, VerificationCard).
create index if not exists spec_test_runs_ws_slug_idx
  on public.spec_test_runs (workspace_id, spec_slug, run_at desc);
create index if not exists spec_test_runs_ws_run_idx
  on public.spec_test_runs (workspace_id, run_at desc);

alter table public.spec_test_runs enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'spec_test_runs' and policyname = 'spec_test_runs_select') then
    create policy spec_test_runs_select on public.spec_test_runs for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'spec_test_runs' and policyname = 'spec_test_runs_service') then
    create policy spec_test_runs_service on public.spec_test_runs for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
