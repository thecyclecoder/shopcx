-- pulse_snapshots: cached synthesis of the founder-pulse five-lens surface.
-- Phase 2 of docs/brain/specs/founder-pulse.md. One row per (workspace_id,
-- subject) — the latest snapshot the /api/developer/pulse route returns
-- (?refresh=1 recomputes). The Phase-3 /pulse page reads this row.
--
-- `subject` = who the snapshot is for. v1 only supports `subject='founder'`;
-- reserved for a future per-role expansion (v2 CFO/Growth surfaces).
--
-- No customer_id column → no Sonnet data tool needed (CLAUDE.md rule for
-- customer-referenced tables does not apply). Owner-only surface — RLS
-- narrows to workspace-member SELECT + service-role full access.

create table if not exists public.pulse_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- WHO the snapshot is for. `founder` in v1; reserved for a future per-role
  -- expansion. The upsert spine is (workspace_id, subject).
  subject text not null default 'founder',
  -- The five lenses of the founder-pulse surface. Shape defined by
  -- src/lib/pulse.ts `PulseLenses` — { whats_working[], where_you_left_off[],
  -- rabbit_holes[], next_moves[], threads_in_flight[] } where each entry is
  -- { claim: string, cite_ids: string[] }.
  lenses jsonb not null default '{}'::jsonb,
  -- Every cite the lenses point at, keyed by a stable id (session digest id /
  -- spec slug / commit sha / job id). Shape: { [cite_id]: { kind, ref, label } }.
  cites jsonb not null default '{}'::jsonb,
  -- Wall-clock the snapshot was computed. The /pulse page renders it as
  -- "Synthesized {relative}" via formatAstTimestamp (AST, no DST).
  synthesized_at timestamptz not null default now(),
  -- The model that wrote the narrative pass (Anthropic model id), or the
  -- literal `deterministic` when the LLM was unavailable / disabled.
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, subject)
);

comment on table public.pulse_snapshots is
  'Cached five-lens synthesis of the founder-pulse surface (one row per (workspace_id, subject)). '
  'Written by src/lib/pulse.ts buildPulse via the /api/developer/pulse route; read by /dashboard/developer/pulse.';

create index if not exists pulse_snapshots_workspace_subject_idx
  on public.pulse_snapshots (workspace_id, subject);

create or replace function public.pulse_snapshots_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists pulse_snapshots_touch_updated_at on public.pulse_snapshots;
create trigger pulse_snapshots_touch_updated_at
  before update on public.pulse_snapshots
  for each row execute function public.pulse_snapshots_touch_updated_at();

alter table public.pulse_snapshots enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'pulse_snapshots' and policyname = 'pulse_snapshots_select') then
    create policy pulse_snapshots_select on public.pulse_snapshots for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'pulse_snapshots' and policyname = 'pulse_snapshots_service') then
    create policy pulse_snapshots_service on public.pulse_snapshots for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
