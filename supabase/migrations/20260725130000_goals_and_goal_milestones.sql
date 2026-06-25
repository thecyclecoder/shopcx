-- Goals + goal_milestones in the DB — the top two tiers of the Goal → Milestone → Spec → Phase
-- hierarchy as data (goals-milestones-tables-and-backfill, db-driven-specs M5).
-- See docs/brain/specs/goals-milestones-tables-and-backfill.md.
--
-- public.goals is the goal row (parent_goal_id self-ref nullable — a SubGoal is just a goal with a parent,
-- per the CEO-locked design contract). public.goal_milestones is one row per "### M{N} — title" sub-section
-- of the goal markdown's ## Decomposition block — a child TABLE (not a jsonb array) so a milestone has a
-- STABLE id across reorders + retitles, and public.specs.milestone_id FKs into it without breaking on edits.
-- A jsonb-style destroy+recreate would silently unattach specs.
--
-- specs.milestone_id was added (nullable) by spec-body-table-and-backfill (20260713120000); this migration
-- adds the FOREIGN KEY constraint pointing at public.goal_milestones(id) on delete set null. Standalone specs
-- (a function-mandate fix, a regression) keep milestone_id=null — that's the intended zero-milestone shape.
--
-- Status at every tier ROLLS UP from children (hard rail, enforced in the DB):
--   • goal_milestones.status from its child public.specs (any in_progress → in_progress; all shipped|folded
--     → complete; otherwise planned).
--   • goals.status from goal_milestones.status BUT only flips greenlit → complete; a still-proposed goal
--     never auto-flips to complete (that would skip the CEO greenlight rail —
--     see goal-greenlight-button-and-author-writes-db).
--
-- Workspace-scoped, RLS-protected. All writes via createAdminClient() (service role). Mirrors public.specs.
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP IF EXISTS + CREATE).

-- ──────────────────────────────────────────────────────────────────────────────
-- public.goals — the goal row (one per slug)
-- ──────────────────────────────────────────────────────────────────────────────
create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the goal slug (docs/brain/goals/{slug}.md — the file key + the upsert spine).
  slug text not null,
  title text not null,
  -- the full goal body (Outcome + Why + Model + Target + Decomposition) — the markdown body parseGoal carries.
  body text not null,
  -- the one-paragraph Outcome: line, as a separate column for the board summary.
  outcome text,
  -- the Success metric: line — the planner's gap-analysis anchor (plan-goal skill).
  success_metric text,
  -- function slug (DRI) — growth | cmo | retention | cfo | logistics | cs | platform. Free-text for now
  -- (no hard FK to a functions table — same shape parseGoal carries today).
  owner text not null,
  -- the Proposed-by: function — set by director-proposed-goals when a director authored the goal; null for
  -- CEO-authored goals.
  proposer_function text,
  -- self-ref NULLABLE — a SubGoal is just a goal with a parent (CEO-locked design contract).
  -- on delete cascade: deleting a parent goal cascades to its subgoals (the design says subgoals are
  -- nested under their parent, not free-standing).
  parent_goal_id uuid references public.goals(id) on delete cascade,
  status text not null default 'proposed' check (
    status in ('proposed','greenlit','complete','folded')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Upsert spine: one row per (workspace, slug). Every backfill / writer goes through this onConflict key.
create unique index if not exists goals_ws_slug on public.goals (workspace_id, slug);
-- The board's nested-goal render (CEO Mode ▸ Fully Autonomous CTO ▸ M1…M5) joins on parent_goal_id.
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
-- public.goal_milestones — one row per ### M{N} sub-section of the goal markdown
-- ──────────────────────────────────────────────────────────────────────────────
-- id is STABLE across reorders + retitles — the same lift-a-thing rule spec_phases enforces. A jsonb-array
-- shape would force destroy+recreate, which would BREAK any public.specs.milestone_id FKs pointing at the
-- milestone (the FK is on delete set null, so a destructive write would silently unattach specs).
create table if not exists public.goal_milestones (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.goals(id) on delete cascade,
  -- 1-indexed position — the milestone ordering surface. Unique per (goal_id, position).
  position int not null,
  title text not null,
  -- the milestone description + sub-bullets the ### M{N} block carries. Markdown-as-text.
  body text,
  status text not null default 'planned' check (
    status in ('planned','in_progress','complete')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists goal_milestones_goal_position on public.goal_milestones (goal_id, position);
create index if not exists goal_milestones_goal_idx on public.goal_milestones (goal_id);

alter table public.goal_milestones enable row level security;

drop policy if exists goal_milestones_select on public.goal_milestones;
create policy goal_milestones_select on public.goal_milestones
  for select to authenticated using (auth.uid() is not null);
drop policy if exists goal_milestones_service on public.goal_milestones;
create policy goal_milestones_service on public.goal_milestones
  for all to service_role using (true) with check (true);

-- ──────────────────────────────────────────────────────────────────────────────
-- public.specs.milestone_id — promote the existing nullable column to a typed FK
-- ──────────────────────────────────────────────────────────────────────────────
-- The column already exists per spec-body-table-and-backfill (20260713120000_specs_and_spec_phases.sql);
-- this migration adds the FK constraint pointing at public.goal_milestones(id). on delete SET NULL so a
-- standalone spec (function mandate, ad-hoc fix, regression) keeps milestone_id=null — that's the intended
-- shape. A spec that loses its milestone (the milestone is deleted) becomes standalone, not orphaned.
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'specs'
      and constraint_name = 'specs_milestone_id_fkey'
  ) then
    alter table public.specs
      add constraint specs_milestone_id_fkey
      foreign key (milestone_id) references public.goal_milestones(id) on delete set null;
  end if;
end $$;

-- ──────────────────────────────────────────────────────────────────────────────
-- Rollup: goal_milestones.status follows public.specs.status
-- ──────────────────────────────────────────────────────────────────────────────
-- Any child spec in_progress → milestone in_progress. All child specs shipped|folded → milestone complete.
-- Otherwise planned. Same hard-rail shape spec_phases_rollup enforces on specs.status.
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
  select status into v_current from public.goal_milestones where id = p_milestone_id;
  if not found then return; end if;

  select
    count(*),
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

create or replace function public.specs_milestone_rollup_trigger()
returns trigger
language plpgsql
as $$
begin
  -- DELETE → rollup the old milestone (the row is leaving).
  if tg_op = 'DELETE' then
    if old.milestone_id is not null then
      perform public.roll_up_milestone_status(old.milestone_id);
    end if;
    return old;
  end if;

  -- INSERT or UPDATE → rollup the (new) milestone. If milestone_id changed, rollup the old one too so
  -- moving a spec between milestones updates BOTH sides.
  if new.milestone_id is not null then
    perform public.roll_up_milestone_status(new.milestone_id);
  end if;
  if tg_op = 'UPDATE' and old.milestone_id is distinct from new.milestone_id and old.milestone_id is not null then
    perform public.roll_up_milestone_status(old.milestone_id);
  end if;
  return new;
end $$;

drop trigger if exists specs_milestone_rollup on public.specs;
create trigger specs_milestone_rollup
  after insert or update of status, milestone_id or delete on public.specs
  for each row execute function public.specs_milestone_rollup_trigger();

-- ──────────────────────────────────────────────────────────────────────────────
-- Rollup: goals.status follows goal_milestones.status (with the CEO-greenlight rail)
-- ──────────────────────────────────────────────────────────────────────────────
-- A goal can flip greenlit → complete automatically when every milestone is complete. It NEVER auto-flips
-- proposed → complete: a proposed goal that's never been greenlit must not silently land as complete —
-- the proposed → greenlit step is the CEO's call (goal-greenlight-button-and-author-writes-db). folded is
-- terminal-ish; the rollup leaves it alone.
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
  select status into v_current from public.goals where id = p_goal_id;
  if not found then return; end if;

  -- proposed + folded are terminal-ish for the rollup: only an explicit write moves them out.
  if v_current in ('proposed','folded') then return; end if;

  select
    count(*),
    count(*) filter (where status = 'complete'),
    count(*) filter (where status = 'in_progress')
  into v_total, v_complete, v_in_progress
  from public.goal_milestones where goal_id = p_goal_id;

  -- A greenlit goal with no milestones stays greenlit (nothing to roll up yet).
  if v_total = 0 then
    return;
  elsif v_complete = v_total then
    v_next := 'complete';
  elsif v_in_progress > 0 or v_complete > 0 then
    v_next := 'greenlit';
  else
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
  after insert or update of status, goal_id or delete on public.goal_milestones
  for each row execute function public.goal_milestones_rollup_trigger();

-- ──────────────────────────────────────────────────────────────────────────────
-- parent_goal_id cycle protection — a goal cannot be its own ancestor
-- ──────────────────────────────────────────────────────────────────────────────
-- The CEO-locked design contract calls out optional-subgoals + reassignment ("a goal CAN be (re)assigned
-- under another goal at any time"), so the move is one UPDATE — but cycles must be rejected at the rail.
-- Walks the parent chain on INSERT/UPDATE; rejects when the chain loops back to the row's own id.
create or replace function public.goals_parent_cycle_guard()
returns trigger
language plpgsql
as $$
declare
  v_cursor uuid;
  v_steps int := 0;
begin
  if new.parent_goal_id is null then
    return new;
  end if;
  if new.parent_goal_id = new.id then
    raise exception 'goals.parent_goal_id cycle: a goal cannot be its own parent (id=%)', new.id;
  end if;
  v_cursor := new.parent_goal_id;
  while v_cursor is not null and v_steps < 64 loop
    if v_cursor = new.id then
      raise exception 'goals.parent_goal_id cycle: id=% reachable via parent chain', new.id;
    end if;
    select parent_goal_id into v_cursor from public.goals where id = v_cursor;
    v_steps := v_steps + 1;
  end loop;
  if v_steps >= 64 then
    raise exception 'goals.parent_goal_id chain exceeded 64 hops — refusing to walk further';
  end if;
  return new;
end $$;

drop trigger if exists goals_parent_cycle on public.goals;
create trigger goals_parent_cycle
  before insert or update of parent_goal_id, id on public.goals
  for each row execute function public.goals_parent_cycle_guard();
