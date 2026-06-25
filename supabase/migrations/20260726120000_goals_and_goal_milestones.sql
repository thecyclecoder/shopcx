-- Goals + milestones in the DB — public.goals + public.goal_milestones + the specs.milestone_id FK
-- constraint (db-driven-specs M5, goals-milestones-tables-and-backfill).
-- See docs/brain/specs/goals-milestones-tables-and-backfill.md.
--
-- The top two tiers of the Goal → Milestone → Spec → Phase hierarchy move into the DB as data, parallel to
-- what specs-and-spec-phases did for the bottom two. goals holds the goal card (slug, title, body, outcome,
-- success_metric, owner, proposer_function, parent_goal_id self-ref, status). goal_milestones holds ONE ROW
-- PER milestone — a child TABLE (not a jsonb array on goals) so a milestone keeps its STABLE id across
-- reorder/retitle, which keeps specs.milestone_id FKs intact (a jsonb-style destroy+recreate would silently
-- unattach every spec via the on-delete-set-null FK below).
--
-- A SubGoal is just a goal with parent_goal_id set — NOT a separate table (CEO-locked design contract). The
-- cycle-protection trigger below rejects any UPDATE that would close a parent loop.
--
-- Status at every tier ROLLS UP from children:
--   goal_milestones.status ← specs.status (via the trigger on public.specs added below)
--   goals.status            ← goal_milestones.status (via the trigger on public.goal_milestones added below)
-- with the explicit guard that goals.status NEVER auto-flips proposed → greenlit (that's the CEO action in
-- goal-greenlight-button-and-author-writes-db); the rollup only flips greenlit → complete.
--
-- Workspace-scoped (mirrors public.specs). RLS: any authenticated user reads; service role does all writes
-- (the writers run with service-role creds). No client-side goal writes.

-- ──────────────────────────────────────────────────────────────────────────────
-- public.goals — the goal card row (one per goal slug per workspace)
-- ──────────────────────────────────────────────────────────────────────────────
create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- docs/brain/goals/{slug}.md key.
  slug text not null,
  title text not null,
  -- the full goal body — outcome + why + model + target as the goal markdown carries today.
  body text not null,
  -- the **Outcome:** one-paragraph line broken out as a column for the board summary.
  outcome text,
  -- the **Success metric:** line — the planner's gap-analysis anchor (plan-goal skill).
  success_metric text,
  -- function slug (DRI) — growth | cmo | retention | cfo | logistics | cs | platform. Free-text (no hard FK
  -- to a functions table that doesn't exist yet); mirrors public.specs.owner.
  owner text not null,
  -- the **Proposed-by:** function set by director-proposed-goals when a director authored the goal. Null for
  -- CEO-authored goals.
  proposer_function text,
  -- NULLABLE self-ref — a SubGoal is just a goal with a parent (CEO-locked design contract). on delete
  -- cascade so deleting a parent goal cleans up its subgoals; the cycle trigger below rejects any UPDATE
  -- that would close a loop.
  parent_goal_id uuid references public.goals(id) on delete cascade,
  -- proposed → greenlit (CEO action) → complete (rollup). folded is terminal-ish (left alone by the rollup).
  status text not null default 'proposed' check (status in ('proposed','greenlit','complete','folded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Upsert spine: one row per (workspace, slug). Every backfill / writer goes through this onConflict key.
create unique index if not exists goals_ws_slug on public.goals (workspace_id, slug);
-- Index the parent self-ref for the board's nested-goal render (CEO Mode ▸ Fully Autonomous CTO ▸ M1…M5).
create index if not exists goals_parent_idx on public.goals (parent_goal_id) where parent_goal_id is not null;
create index if not exists goals_ws_status_idx on public.goals (workspace_id, status);

alter table public.goals enable row level security;

drop policy if exists goals_select on public.goals;
create policy goals_select on public.goals
  for select to authenticated using (auth.uid() is not null);
drop policy if exists goals_service on public.goals;
create policy goals_service on public.goals
  for all to service_role using (true) with check (true);

-- ──────────────────────────────────────────────────────────────────────────────
-- public.goal_milestones — one row per milestone of every goal
-- ──────────────────────────────────────────────────────────────────────────────
-- Stable id across reorders / retitles — the same lift-a-thing rule that motivates spec_phases. Reordering a
-- milestone in the parsed source UPSERTs by (goal_id, position) preserving id; a jsonb-style destroy+recreate
-- would break public.specs.milestone_id FKs pointing at the milestone (on delete set null silently unattaches
-- the specs).
create table if not exists public.goal_milestones (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.goals(id) on delete cascade,
  -- 1-indexed milestone position — the ordering surface. Unique per (goal_id, position).
  position int not null,
  -- e.g. "M1 — The spec body in the DB".
  title text not null,
  -- the markdown block under the ### M{N} heading — bullets + prose.
  body text,
  -- planned → in_progress (rolled up from child specs) → complete (all children shipped/folded).
  status text not null default 'planned' check (status in ('planned','in_progress','complete')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists goal_milestones_goal_position on public.goal_milestones (goal_id, position);
create index if not exists goal_milestones_goal_idx on public.goal_milestones (goal_id);
create index if not exists goal_milestones_status_idx on public.goal_milestones (status);

alter table public.goal_milestones enable row level security;

drop policy if exists goal_milestones_select on public.goal_milestones;
create policy goal_milestones_select on public.goal_milestones
  for select to authenticated using (auth.uid() is not null);
drop policy if exists goal_milestones_service on public.goal_milestones;
create policy goal_milestones_service on public.goal_milestones
  for all to service_role using (true) with check (true);

-- ──────────────────────────────────────────────────────────────────────────────
-- public.specs.milestone_id — promote the column (already created by spec-body-table-and-backfill) to a
-- foreign key pointing at goal_milestones(id). on delete set null is the intended shape: if a milestone is
-- removed (rare — a milestone re-shape mid-flight), its specs hang as standalone instead of cascade-deleting.
-- ──────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'specs_milestone_id_fkey'
      and conrelid = 'public.specs'::regclass
  ) then
    alter table public.specs
      add constraint specs_milestone_id_fkey
      foreign key (milestone_id) references public.goal_milestones(id) on delete set null;
  end if;
end $$;

-- ──────────────────────────────────────────────────────────────────────────────
-- Rollup: goal_milestones.status follows the child public.specs rows
-- ──────────────────────────────────────────────────────────────────────────────
-- Any child spec in_progress / partial-shipped → in_progress; all (ignoring rejected) shipped|folded →
-- complete; otherwise planned. Same shape as roll_up_spec_status.
create or replace function public.roll_up_milestone_status(p_milestone_id uuid)
returns void
language plpgsql
as $$
declare
  v_total int;
  v_done int;
  v_in_progress int;
  v_current text;
  v_next text;
begin
  if p_milestone_id is null then return; end if;
  select status into v_current from public.goal_milestones where id = p_milestone_id;
  if not found then return; end if;

  select
    count(*) filter (where status not in ('rejected')),
    count(*) filter (where status in ('shipped','folded')),
    count(*) filter (where status = 'in_progress')
  into v_total, v_done, v_in_progress
  from public.specs where milestone_id = p_milestone_id;

  if v_total = 0 then
    v_next := 'planned';
  elsif v_done = v_total then
    v_next := 'complete';
  elsif v_in_progress > 0 or v_done > 0 then
    v_next := 'in_progress';
  else
    v_next := 'planned';
  end if;

  if v_current is distinct from v_next then
    update public.goal_milestones set status = v_next, updated_at = now() where id = p_milestone_id;
  end if;
end $$;

-- Trigger on public.specs — recompute the parent milestone's rollup after any change to status or to which
-- milestone the spec belongs to. A spec moving milestones fires the rollup on BOTH sides.
create or replace function public.specs_milestone_rollup_trigger()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    perform public.roll_up_milestone_status(old.milestone_id);
    return old;
  end if;
  perform public.roll_up_milestone_status(new.milestone_id);
  if tg_op = 'UPDATE' and old.milestone_id is distinct from new.milestone_id then
    perform public.roll_up_milestone_status(old.milestone_id);
  end if;
  return new;
end $$;

drop trigger if exists specs_milestone_rollup on public.specs;
create trigger specs_milestone_rollup
  after insert or update or delete on public.specs
  for each row execute function public.specs_milestone_rollup_trigger();

-- ──────────────────────────────────────────────────────────────────────────────
-- Rollup: goals.status follows the child goal_milestones rows
-- ──────────────────────────────────────────────────────────────────────────────
-- Hard rail: NEVER auto-flip proposed → greenlit (that's the CEO action in
-- goal-greenlight-button-and-author-writes-db). Only flip greenlit → complete when every milestone is
-- complete. folded is terminal-ish (left alone). A proposed goal whose milestones are all complete stays
-- proposed — it never auto-greenlights itself.
create or replace function public.roll_up_goal_status(p_goal_id uuid)
returns void
language plpgsql
as $$
declare
  v_total int;
  v_complete int;
  v_in_progress int;
  v_current text;
  v_next text;
begin
  if p_goal_id is null then return; end if;
  select status into v_current from public.goals where id = p_goal_id;
  if not found then return; end if;

  -- Terminal-ish: proposed + folded are NEVER overwritten by the rollup. The CEO greenlight write surface
  -- is the only path out of proposed; the fold worker the only path into folded.
  if v_current in ('proposed','folded') then return; end if;

  select
    count(*),
    count(*) filter (where status = 'complete'),
    count(*) filter (where status = 'in_progress')
  into v_total, v_complete, v_in_progress
  from public.goal_milestones where goal_id = p_goal_id;

  if v_total = 0 then
    -- A goal with no milestones stays whatever it is — usually greenlit awaiting decomposition.
    return;
  elsif v_complete = v_total then
    v_next := 'complete';
  else
    -- Any non-complete sibling → stay greenlit.
    v_next := 'greenlit';
  end if;

  if v_current is distinct from v_next then
    update public.goals set status = v_next, updated_at = now() where id = p_goal_id;
  end if;
end $$;

create or replace function public.goal_milestones_rollup_trigger()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    perform public.roll_up_goal_status(old.goal_id);
    return old;
  end if;
  perform public.roll_up_goal_status(new.goal_id);
  if tg_op = 'UPDATE' and old.goal_id is distinct from new.goal_id then
    perform public.roll_up_goal_status(old.goal_id);
  end if;
  return new;
end $$;

drop trigger if exists goal_milestones_rollup on public.goal_milestones;
create trigger goal_milestones_rollup
  after insert or update or delete on public.goal_milestones
  for each row execute function public.goal_milestones_rollup_trigger();

-- ──────────────────────────────────────────────────────────────────────────────
-- Cycle protection on goals.parent_goal_id
-- ──────────────────────────────────────────────────────────────────────────────
-- The design contract allows re-parenting at any time (a goal CAN be reassigned under another goal), but a
-- cycle (A→B→…→A) must be rejected at the rail. Walk the parent chain on INSERT/UPDATE and raise if the row
-- itself appears anywhere in the ancestry. Bounded walk (max 64 hops) so a malformed pre-existing cycle can't
-- spin forever.
create or replace function public.goals_parent_cycle_check()
returns trigger
language plpgsql
as $$
declare
  v_cursor uuid;
  v_hops int := 0;
begin
  if new.parent_goal_id is null then return new; end if;
  if new.parent_goal_id = new.id then
    raise exception 'goals.parent_goal_id cycle: goal % cannot be its own parent', new.id;
  end if;
  v_cursor := new.parent_goal_id;
  while v_cursor is not null and v_hops < 64 loop
    if v_cursor = new.id then
      raise exception 'goals.parent_goal_id cycle: goal % already appears in the ancestry chain', new.id;
    end if;
    select parent_goal_id into v_cursor from public.goals where id = v_cursor;
    v_hops := v_hops + 1;
  end loop;
  return new;
end $$;

drop trigger if exists goals_parent_cycle on public.goals;
create trigger goals_parent_cycle
  before insert or update of parent_goal_id on public.goals
  for each row execute function public.goals_parent_cycle_check();
