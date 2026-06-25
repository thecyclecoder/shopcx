-- Goals + milestones in the DB — public.goals + public.goal_milestones + the specs.milestone_id FK
-- (db-driven-specs M5, goals-milestones-tables-and-backfill Phase 1).
-- See docs/brain/specs/goals-milestones-tables-and-backfill.md.
--
-- The top two tiers of Goal → Milestone → Spec → Phase move into the DB. goals holds the goal card
-- (title, body, outcome, success_metric, owner, proposer_function, status, parent_goal_id self-ref —
-- a SubGoal is just a goal with a parent, NOT a separate table, per the CEO-locked design contract).
-- goal_milestones holds ONE ROW PER MILESTONE (a child TABLE keyed by (goal_id, position)).
-- specs gains a foreign-key constraint on milestone_id pointing at goal_milestones(id) — the column
-- itself was already declared nullable by spec-body-table-and-backfill's migration; this migration
-- adds the FK constraint and the on-delete-set-null rule.
--
-- Status at every tier ROLLS UP from children: goal_milestones.status from its child specs.status
-- (which already rolls up from spec_phases via the M1 trigger); goals.status from its
-- goal_milestones.status (with the explicit proposed → greenlit flip the CEO controls — that's NOT
-- this trigger's job; it only auto-flips greenlit → complete when every milestone is complete).
--
-- The .md files in docs/brain/goals/ stay authoritative until goal-readers-from-db-retire-parsegoal
-- cuts readers over; this spec only ADDS the new relations + (in later phases) backfills them.
--
-- Workspace-scoped (mirrors specs). RLS: any authenticated user reads; service role does all writes.

-- ──────────────────────────────────────────────────────────────────────────────
-- public.goals — the goal card row (one per goal)
-- ──────────────────────────────────────────────────────────────────────────────
create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the goal slug (docs/brain/goals/{slug}.md — the file key). Stays the human-facing identifier.
  slug text not null,
  title text not null,
  -- the goal's full body — outcome + why-now + model + target + success-metric + decomposition narrative.
  -- The full prose the goal markdown carries today (so a retire-parseGoal cutover can render from this column).
  body text not null,
  -- the **Outcome:** one-paragraph line, lifted out for the board's at-a-glance summary.
  outcome text,
  -- the **Success metric:** line — the planner's gap-analysis anchor (see ../skills/plan-goal).
  success_metric text,
  -- function slug (the DRI) — growth | cmo | retention | cfo | logistics | cs | platform. Free-text to
  -- avoid forcing a hard FK against the functions table before it catches up (matches public.specs.owner).
  owner text not null,
  -- the **Proposed-by:** function — set by director-proposed-goals when a director authored the goal.
  -- Null for CEO-authored goals.
  proposer_function text,
  -- self-ref parent. A SubGoal is just a goal with parent_goal_id set (NOT a separate table) —
  -- the CEO-locked design contract. Most goals have no parent; reassignment is a single UPDATE.
  -- on delete cascade so removing a parent removes its subgoals too (the board's nested render is the
  -- intended shape — a stray orphan subgoal isn't useful).
  parent_goal_id uuid references public.goals(id) on delete cascade,
  -- lifecycle. `proposed` — a director authored it, awaits the CEO's greenlight (inert: the escort
  -- doesn't touch it, Pia doesn't decompose it). `greenlit` — the CEO approved it; active.
  -- `complete` — every milestone rolled up complete. `folded` — terminal-ish, the brain page has
  -- been written + the DB row preserved (goal-fold-from-db-row, db-driven-specs M5 follow-up).
  status text not null default 'proposed' check (status in ('proposed','greenlit','complete','folded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Upsert spine: one row per (workspace, slug). Every backfill / writer goes through this onConflict key.
create unique index if not exists goals_ws_slug on public.goals (workspace_id, slug);
create index if not exists goals_ws_status_idx on public.goals (workspace_id, status);
-- Board's nested-goal render (CEO Mode ▸ subgoals ▸ M1…M5 ▸ specs ▸ phases) — joins by parent.
create index if not exists goals_parent_idx on public.goals (parent_goal_id) where parent_goal_id is not null;

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
-- Stable id across reorders, same lift-a-thing rule as spec_phases — retitling or moving a milestone
-- is an UPDATE that preserves its id, so existing specs.milestone_id FKs survive the reorder. A
-- jsonb-style destroy+recreate would silently unattach every child spec (FK is on delete set null).
create table if not exists public.goal_milestones (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.goals(id) on delete cascade,
  position int not null,
  title text not null,
  body text,
  status text not null default 'planned' check (status in ('planned','in_progress','complete')),
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
-- public.specs.milestone_id — add the FK constraint pointing at public.goal_milestones(id)
-- ──────────────────────────────────────────────────────────────────────────────
-- The COLUMN itself was added (nullable uuid, no constraint) by 20260713120000_specs_and_spec_phases.sql
-- (spec-body-table-and-backfill). This migration adds the foreign-key constraint with `on delete set null`,
-- so deleting a milestone unattaches its child specs rather than cascading (a standalone spec with
-- milestone_id=null is the intended shape per the spec contract).
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema='public' and table_name='specs' and constraint_name='specs_milestone_id_fkey'
  ) then
    alter table public.specs
      add constraint specs_milestone_id_fkey
      foreign key (milestone_id) references public.goal_milestones(id) on delete set null;
  end if;
end $$;

-- ──────────────────────────────────────────────────────────────────────────────
-- Rollup: goal_milestones.status follows specs.status; goals.status follows goal_milestones.status
-- ──────────────────────────────────────────────────────────────────────────────
-- A milestone's status is `complete` only when every child spec is shipped/folded; otherwise
-- `in_progress` if any spec is in progress, else `planned`. Standalone specs (milestone_id=null)
-- are ignored — they hang off a function mandate, not a milestone.
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

-- A goal's status rolls greenlit → complete when every milestone is complete. We DO NOT auto-flip
-- proposed → greenlit (that's the CEO action in goal-greenlight-button-and-author-writes-db). A
-- still-proposed goal whose milestones happen to all be complete stays proposed — a rail break
-- otherwise. complete/folded are terminal-ish: the rollup never overwrites them.
create or replace function public.roll_up_goal_status(p_goal_id uuid)
returns void
language plpgsql
as $$
declare
  v_total int;
  v_complete int;
  v_current text;
  v_next text;
begin
  select status into v_current from public.goals where id = p_goal_id;
  if not found then return; end if;
  if v_current in ('proposed','complete','folded') then return; end if;

  select count(*), count(*) filter (where status = 'complete')
    into v_total, v_complete
    from public.goal_milestones where goal_id = p_goal_id;

  if v_total > 0 and v_complete = v_total then
    v_next := 'complete';
  else
    return;
  end if;

  if v_current is distinct from v_next then
    update public.goals set status = v_next, updated_at = now() where id = p_goal_id;
  end if;
end $$;

-- Trigger on specs: when status or milestone_id changes, roll up the affected milestone(s).
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

  if tg_op = 'INSERT' then
    if new.milestone_id is not null then
      perform public.roll_up_milestone_status(new.milestone_id);
    end if;
    return new;
  end if;

  -- UPDATE: fire on both the old + new milestone when the link moved, OR when the spec's status changed.
  if old.milestone_id is distinct from new.milestone_id then
    if old.milestone_id is not null then
      perform public.roll_up_milestone_status(old.milestone_id);
    end if;
    if new.milestone_id is not null then
      perform public.roll_up_milestone_status(new.milestone_id);
    end if;
  elsif old.status is distinct from new.status and new.milestone_id is not null then
    perform public.roll_up_milestone_status(new.milestone_id);
  end if;
  return new;
end $$;

drop trigger if exists specs_milestone_rollup on public.specs;
create trigger specs_milestone_rollup
  after insert or update or delete on public.specs
  for each row execute function public.specs_milestone_rollup_trigger();

-- Trigger on goal_milestones: when a milestone's status changes, roll up the parent goal.
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
-- parent_goal_id cycle protection — a goal CANNOT be its own ancestor
-- ──────────────────────────────────────────────────────────────────────────────
-- The design contract allows reassignment ("a goal CAN be (re)assigned under another goal at any
-- time"), so the move is one UPDATE — but a cycle (G1 → G2 → G1) must be rejected at the rail.
-- Walk the parent chain on INSERT / UPDATE and raise if the new id is reachable from itself.
create or replace function public.goals_no_cycle_trigger()
returns trigger
language plpgsql
as $$
declare
  v_cursor uuid;
  v_depth int := 0;
begin
  if new.parent_goal_id is null then return new; end if;
  if new.parent_goal_id = new.id then
    raise exception 'goals.parent_goal_id cycle: a goal cannot be its own parent (id=%)', new.id;
  end if;
  v_cursor := new.parent_goal_id;
  while v_cursor is not null loop
    v_depth := v_depth + 1;
    if v_depth > 64 then
      raise exception 'goals.parent_goal_id chain too deep (>64) starting from id=%', new.id;
    end if;
    if v_cursor = new.id then
      raise exception 'goals.parent_goal_id cycle: setting parent=% on id=% closes a loop', new.parent_goal_id, new.id;
    end if;
    select parent_goal_id into v_cursor from public.goals where id = v_cursor;
  end loop;
  return new;
end $$;

drop trigger if exists goals_no_cycle on public.goals;
create trigger goals_no_cycle
  before insert or update of parent_goal_id on public.goals
  for each row execute function public.goals_no_cycle_trigger();
