-- Goals + milestones in the DB — public.goals + public.goal_milestones + the FK constraint on
-- public.specs.milestone_id (db-driven-specs M5, goals-milestones-tables-and-backfill Phase 1).
-- See docs/brain/specs/goals-milestones-tables-and-backfill.md.
--
-- The top two tiers of the Goal → Milestone → Spec → Phase hierarchy move into the DB. goals holds the
-- card row (title, body, outcome, success_metric, owner, proposer_function, parent_goal_id self-ref,
-- status). goal_milestones holds ONE ROW PER MILESTONE (a child TABLE — same lift-a-thing rule as
-- spec_phases: a milestone keeps its stable id across reorder/retitle, so any specs.milestone_id FK
-- pointing at it survives).
--
-- A **SubGoal is just a goal with a parent_goal_id** — NOT a separate table (CEO-locked design
-- contract). parent_goal_id is nullable + acyclic (enforced by a CHECK trigger that walks the chain).
--
-- Status rolls up at every tier: goal_milestones.status from its child public.specs.status rows; goals
-- from goal_milestones. The proposed→greenlit flip is CEO-only (goal-greenlight-button-and-author-
-- writes-db) — the rollup NEVER auto-greenlights a proposed goal, even if every milestone completes;
-- it only flips greenlit → complete. A still-proposed goal stays proposed (a rail).
--
-- Workspace-scoped (mirrors public.specs). RLS: any authenticated user reads; service role does all
-- writes (the writers hold service-role creds). No client-side goal writes.

-- ──────────────────────────────────────────────────────────────────────────────
-- public.goals — one row per goal (a SubGoal is just a goal with a parent)
-- ──────────────────────────────────────────────────────────────────────────────
create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the goal slug (docs/brain/goals/{slug}.md — the file key, the upsert spine).
  slug text not null,
  title text not null,
  -- the full body the goal markdown carries today (outcome + why + model + target prose).
  body text not null,
  -- the one-paragraph **Outcome:** line — pulled out as a column for the board summary.
  outcome text,
  -- the **Success metric:** line — the planner's gap-analysis anchor (plan-goal skill).
  success_metric text,
  -- function slug (DRI) — growth | cmo | retention | cfo | logistics | cs | platform.
  -- Free-text for now (no hard FK before the functions table catches up).
  owner text not null,
  -- the **Proposed-by:** function (director-proposed-goals). Null for a CEO-authored goal.
  proposer_function text,
  -- NULLABLE self-ref. A SubGoal is just a goal with a parent (CEO-locked design contract). Acyclicity
  -- is enforced by the trigger below (parent chain must terminate).
  parent_goal_id uuid references public.goals(id) on delete cascade,
  -- the goal's lifecycle state. proposed → greenlit is CEO-only (the goal-greenlight button); the
  -- rollup trigger only auto-flips greenlit → complete. folded is set by the goal-fold-from-db-row
  -- worker and is terminal-ish (preserved for audit).
  status text not null default 'proposed' check (
    status in ('proposed','greenlit','complete','folded')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Upsert spine: one row per (workspace, slug). Every writer goes through this onConflict key.
create unique index if not exists goals_ws_slug on public.goals (workspace_id, slug);
-- For the board's nested-goal render (CEO Mode ▸ Fully Autonomous CTO ▸ M1…M5 ▸ specs ▸ phases).
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
-- public.goal_milestones — one row per milestone (a child TABLE, not a jsonb array)
-- ──────────────────────────────────────────────────────────────────────────────
-- The milestone id is STABLE across reorder/retitle — UPSERT-by-(goal_id, position) preserves id, so
-- any public.specs.milestone_id FK pointing at the milestone survives. A jsonb-style destroy+recreate
-- would silently unattach specs (the FK is on delete set null).
create table if not exists public.goal_milestones (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.goals(id) on delete cascade,
  -- 1-indexed position — the ordering surface. Unique per (goal_id, position).
  position int not null,
  -- e.g. "M1 — The spec body in the DB".
  title text not null,
  -- the markdown block under the `### M{N}` heading (description + sub-bullets).
  body text,
  -- rolled up from child public.specs.status rows by the trigger below. The rule mirrors specs: all
  -- shipped|folded → complete; any in_progress → in_progress; else planned.
  status text not null default 'planned' check (
    status in ('planned','in_progress','complete')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists goal_milestones_goal_position on public.goal_milestones (goal_id, position);
create index if not exists goal_milestones_goal_idx on public.goal_milestones (goal_id);
create index if not exists goal_milestones_status_idx on public.goal_milestones (goal_id, status);

alter table public.goal_milestones enable row level security;

drop policy if exists goal_milestones_select on public.goal_milestones;
create policy goal_milestones_select on public.goal_milestones
  for select to authenticated using (auth.uid() is not null);
drop policy if exists goal_milestones_service on public.goal_milestones;
create policy goal_milestones_service on public.goal_milestones
  for all to service_role using (true) with check (true);

-- ──────────────────────────────────────────────────────────────────────────────
-- public.specs.milestone_id — promote to a typed FK
-- ──────────────────────────────────────────────────────────────────────────────
-- The column already exists per spec-body-table-and-backfill's schema (declared uuid, nullable, no FK).
-- This migration adds the references constraint pointing at goal_milestones. on delete set null so a
-- milestone delete doesn't cascade-orphan its specs — the specs stay, with milestone_id reset to null
-- (a standalone-spec shape — the explicit zero-milestone case is supported).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'specs_milestone_id_fkey'
  ) then
    alter table public.specs
      add constraint specs_milestone_id_fkey
      foreign key (milestone_id) references public.goal_milestones(id) on delete set null;
  end if;
end $$;

-- ──────────────────────────────────────────────────────────────────────────────
-- Acyclicity guard: parent_goal_id must not form a cycle
-- ──────────────────────────────────────────────────────────────────────────────
-- A goal CANNOT be its own ancestor. The design contract allows reassignment ("a goal CAN be
-- (re)assigned under another goal at any time") so the move is one UPDATE, but cycles must be
-- rejected at the rail. Walks the parent chain on INSERT/UPDATE; bounded at 32 hops as a runaway
-- backstop (deep nesting beyond that is itself a structural smell).
create or replace function public.goals_no_cycle_trigger()
returns trigger
language plpgsql
as $$
declare
  v_cursor uuid := new.parent_goal_id;
  v_hops int := 0;
begin
  if v_cursor is null then return new; end if;
  while v_cursor is not null and v_hops < 32 loop
    if v_cursor = new.id then
      raise exception 'parent_goal_id cycle: goal % cannot be its own ancestor', new.id
        using errcode = '23514';
    end if;
    select parent_goal_id into v_cursor from public.goals where id = v_cursor;
    v_hops := v_hops + 1;
  end loop;
  if v_hops >= 32 then
    raise exception 'parent_goal_id chain exceeds 32 hops (cycle or pathological nesting)'
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists goals_no_cycle on public.goals;
create trigger goals_no_cycle
  before insert or update of parent_goal_id on public.goals
  for each row execute function public.goals_no_cycle_trigger();

-- ──────────────────────────────────────────────────────────────────────────────
-- Rollup: goal_milestones.status follows public.specs.status
-- ──────────────────────────────────────────────────────────────────────────────
-- The rule: read every spec whose milestone_id = $1; any in_progress → in_progress; if at least one
-- spec exists and all are shipped|folded → complete; otherwise planned. A milestone with no attached
-- specs stays at whatever it was (planned by default) — we don't drag it to complete just because the
-- spec set is empty.
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
    v_next := v_current;  -- no attached specs: leave the milestone alone.
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

-- The spec-side trigger: when a spec's status or milestone_id changes, recompute the affected
-- milestone(s). A re-attach (specs.milestone_id changed) recomputes BOTH the old and the new milestone.
create or replace function public.specs_milestone_rollup_trigger()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.milestone_id is not null then
      perform public.roll_up_milestone_status(old.milestone_id);
    end if;
    return old;
  end if;
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
-- Rollup: goals.status follows goal_milestones.status (greenlit → complete only)
-- ──────────────────────────────────────────────────────────────────────────────
-- The rule: read every milestone for the goal. If every milestone is complete, AND the goal is
-- currently greenlit, → complete. A still-proposed goal stays proposed (the rail — only the CEO
-- greenlight button can flip proposed → greenlit; goal-greenlight-button-and-author-writes-db).
-- folded is terminal — never overwritten by the rollup.
create or replace function public.roll_up_goal_status(p_goal_id uuid)
returns void
language plpgsql
as $$
declare
  v_total int;
  v_done int;
  v_current text;
begin
  select status into v_current from public.goals where id = p_goal_id;
  if not found then return; end if;
  if v_current in ('proposed','folded') then return; end if;

  select
    count(*),
    count(*) filter (where status = 'complete')
  into v_total, v_done
  from public.goal_milestones where goal_id = p_goal_id;

  if v_total > 0 and v_done = v_total and v_current = 'greenlit' then
    update public.goals set status = 'complete', updated_at = now() where id = p_goal_id;
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
