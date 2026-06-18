-- agent_jobs: the build queue bridging the dashboard "Build" button (Vercel) to the
-- self-hosted box worker (tailnet-only, polls outbound). One row per build of a spec.
-- See docs/brain/specs/roadmap-build-console.md (Phase 3/4/5).

create table if not exists public.agent_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  spec_slug text not null,
  spec_branch text,
  instructions text,
  -- queued | claimed | building | needs_input | queued_resume | completed | failed | needs_attention
  status text not null default 'queued',
  claude_session_id text,        -- captured from stream-json; used for `claude --resume`
  questions jsonb not null default '[]'::jsonb,   -- [{id,q,options?}] surfaced when needs_input
  answers jsonb not null default '[]'::jsonb,      -- [{id,answer}] typed by the owner
  pr_url text,
  pr_number integer,
  log_tail text,
  error text,
  claimed_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_jobs_ws_status_idx on public.agent_jobs (workspace_id, status, created_at desc);
create index if not exists agent_jobs_slug_idx on public.agent_jobs (workspace_id, spec_slug, created_at desc);

alter table public.agent_jobs enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'agent_jobs' and policyname = 'agent_jobs_select') then
    create policy agent_jobs_select on public.agent_jobs for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'agent_jobs' and policyname = 'agent_jobs_service') then
    create policy agent_jobs_service on public.agent_jobs for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;

-- Atomic claim for the worker: grab the oldest queued / queued_resume job and mark it
-- claimed in one transaction (FOR UPDATE SKIP LOCKED → safe for concurrent workers).
create or replace function public.claim_agent_job()
returns public.agent_jobs
language plpgsql
as $$
declare
  job public.agent_jobs;
begin
  select * into job from public.agent_jobs
    where status in ('queued', 'queued_resume')
    order by created_at
    for update skip locked
    limit 1;
  if not found then
    return null;
  end if;
  update public.agent_jobs
    set status = 'building', claimed_at = now(), updated_at = now()
    where id = job.id
    returning * into job;
  return job;
end $$;
