-- pulse_session_digests: LLM-distilled digest of each local Claude session,
-- upserted idempotently on session_id (the jsonl filename slug on the
-- founder's Mac).
--
-- Phase 1 of docs/brain/specs/founder-pulse.md — the read-only context-
-- reconstitution surface. `scripts/pulse-digest.ts` runs LOCALLY on the
-- founder's Mac (the box has no filesystem access to ~/.claude/projects/…),
-- reads every *.jsonl in ~/.claude/projects/-Users-admin-Projects-shopcx/,
-- extracts human turns + terminal actions, and calls the Anthropic API to
-- distill each session into {intent, resume_point, decisions[], threads[],
-- refs[]}. The Phase-2 pulse.ts synthesizer joins these rows against the
-- specs / agent_jobs ledger to write the five lenses.
--
-- No customer_id column → no Sonnet data tool needed (CLAUDE.md rule for
-- customer-referenced tables does not apply). Owner-only surface — read
-- policy narrows to workspace_members like the rest of the developer portal.

create table if not exists public.pulse_session_digests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The Claude session file's stable id (jsonl basename without extension).
  -- Same session on the founder's Mac → same session_id → this is the upsert spine.
  session_id text not null,
  -- The project slug from ~/.claude/projects/{project}/ — e.g. `-Users-admin-Projects-shopcx`.
  project text,
  -- First/last human-turn timestamps observed in the jsonl (UTC in the DB;
  -- the /pulse renderer normalizes to America/Puerto_Rico for display —
  -- founder is AST, no DST; the bug caught by local session 4e303b13).
  started_at timestamptz,
  last_activity_at timestamptz,
  -- Distiller output. `intent` = what this session was trying to do (from the
  -- first human turn). `resume_point` = where the founder left off (from the
  -- last few turns + any terminal submit-spec/commit/PR action).
  intent text,
  resume_point text,
  -- Arrays of small objects; shape defined by src/lib/pulse-digest.ts.
  decisions jsonb not null default '[]'::jsonb,
  threads jsonb not null default '[]'::jsonb,
  refs jsonb not null default '[]'::jsonb,
  -- Which Anthropic model + the source jsonl fingerprint (mtime_ms + size)
  -- so an unchanged file can be skipped on the next run without re-hashing.
  digest_model text,
  source_mtime_ms bigint,
  source_size_bytes bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, session_id)
);

comment on table public.pulse_session_digests is
  'One row per local Claude session on the founder Mac. Upserted by scripts/pulse-digest.ts '
  'via src/lib/pulse-digest.ts. Read by src/lib/pulse.ts (Phase 2) to synthesize the founder-pulse lenses.';

create index if not exists pulse_session_digests_workspace_last_activity_idx
  on public.pulse_session_digests (workspace_id, last_activity_at desc);

-- updated_at auto-bump on any UPDATE (mirrors adlibrary_searches).
create or replace function public.pulse_session_digests_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists pulse_session_digests_touch_updated_at on public.pulse_session_digests;
create trigger pulse_session_digests_touch_updated_at
  before update on public.pulse_session_digests
  for each row execute function public.pulse_session_digests_touch_updated_at();

alter table public.pulse_session_digests enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'pulse_session_digests' and policyname = 'pulse_session_digests_select') then
    create policy pulse_session_digests_select on public.pulse_session_digests for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'pulse_session_digests' and policyname = 'pulse_session_digests_service') then
    create policy pulse_session_digests_service on public.pulse_session_digests for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
