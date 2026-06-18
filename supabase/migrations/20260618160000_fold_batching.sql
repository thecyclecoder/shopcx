-- Fold-build batching (docs/brain/specs/fold-build-batching.md).
-- Problem: every "Mark verified & archive" used to spawn ONE build per spec, and each fold edited the
-- same top line of docs/brain/archive.md + README counts — so a batch of folds went mutually Dirty.
-- Fix at the queue level: mark specs pending-fold, coalesce into ONE kind='fold' job that folds them
-- all in one branch/PR, and run that fold lane at concurrency 1 so it never races a feature build.

-- ── pending_folds: the set of shipped specs the owner has marked verified, awaiting a fold-build ──
-- One row per spec (per workspace). A fold job snapshots all 'pending' rows for the workspace, marks
-- them 'folding', folds them in one PR, then marks them 'folded'. New verifies join the NEXT batch.
create table if not exists public.pending_folds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  spec_slug text not null,
  -- pending (queued for the next fold) | folding (claimed by a fold job) | folded (PR opened) | failed
  status text not null default 'pending',
  job_id uuid references public.agent_jobs(id) on delete set null, -- the fold job that claimed it
  requested_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, spec_slug)
);

create index if not exists pending_folds_ws_status_idx on public.pending_folds (workspace_id, status, created_at);

alter table public.pending_folds enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'pending_folds' and policyname = 'pending_folds_select') then
    create policy pending_folds_select on public.pending_folds for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'pending_folds' and policyname = 'pending_folds_service') then
    create policy pending_folds_service on public.pending_folds for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;

-- At most ONE queued fold job per workspace (belt-and-suspenders for enqueue_fold's coalesce). Once a
-- fold job is claimed (status leaves 'queued') a later verify can open a fresh queued job for the next
-- batch — that's intentional: specs verified mid-fold ride the next lane, never the in-flight snapshot.
create unique index if not exists agent_jobs_one_queued_fold_idx
  on public.agent_jobs (workspace_id)
  where (kind = 'fold' and status = 'queued');

-- ── kind-aware claim: the worker runs folds in their own concurrency-1 lane (Phase 2) ──
-- Replaces the zero-arg claim_agent_job(). p_kinds NULL = any kind (back-compat); otherwise only claim
-- jobs whose kind is in the list. Must DROP first: a defaulted overload would be ambiguous with the old
-- zero-arg function on a no-arg call.
drop function if exists public.claim_agent_job();
create or replace function public.claim_agent_job(p_kinds text[] default null)
returns public.agent_jobs
language plpgsql
as $$
declare
  job public.agent_jobs;
begin
  select * into job from public.agent_jobs
    where status in ('queued', 'queued_resume')
      and (p_kinds is null or kind = any(p_kinds))
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

-- ── enqueue_fold: atomic coalesce for "Mark verified & archive" ──
-- Marks the spec pending-fold and ensures exactly ONE queued fold job exists for the workspace,
-- returning it. Serialized per-workspace by an advisory xact lock so two simultaneous verifies can't
-- race a double fold job. Reuses the claim_agent_job() concurrency discipline. See spec Phase 1.
create or replace function public.enqueue_fold(p_workspace uuid, p_slug text, p_user uuid default null)
returns public.agent_jobs
language plpgsql
as $$
declare
  job public.agent_jobs;
begin
  perform pg_advisory_xact_lock(hashtext('fold:' || p_workspace::text));

  -- Mark the spec pending-fold. If it's already pending/folding leave it untouched (don't reopen a row
  -- a fold job is mid-folding); only re-open a previously folded/failed row.
  insert into public.pending_folds (workspace_id, spec_slug, status, requested_by)
    values (p_workspace, p_slug, 'pending', p_user)
  on conflict (workspace_id, spec_slug) do update
    set status = 'pending', requested_by = excluded.requested_by, updated_at = now()
    where public.pending_folds.status not in ('pending', 'folding');

  -- Reuse an already-queued fold job (the spec joins that batch); else open one.
  select * into job from public.agent_jobs
    where workspace_id = p_workspace and kind = 'fold' and status = 'queued'
    order by created_at
    limit 1;
  if not found then
    insert into public.agent_jobs (workspace_id, spec_slug, kind, status, created_by, instructions)
      values (p_workspace, 'fold-batch', 'fold', 'queued', p_user,
              'Batch fold-build: fold every pending-fold spec into the brain in one PR.')
      returning * into job;
  end if;
  return job;
end $$;
