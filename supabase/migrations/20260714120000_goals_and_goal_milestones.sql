-- Goal body + milestones in the DB — public.goals + public.goal_milestones + specs.milestone_id FK
-- (db-driven-specs M5, goals-milestones-tables-and-backfill). See
-- docs/brain/specs/goals-milestones-tables-and-backfill.md.
--
-- The top two tiers of Goal → Milestone → Spec → Phase move into the DB. goals holds the goal card
-- (slug, title, body, outcome, success_metric, owner, proposer_function, parent_goal_id self-ref,
-- status). goal_milestones holds ONE ROW PER MILESTONE — a child TABLE (not a jsonb array on goals)
-- so a milestone retains a stable id across reorders and so public.specs.milestone_id FKs survive a
-- retitle. A jsonb array would force destroy+recreate which would silently unattach specs (the FK
-- is `on delete set null`).
--
-- A **SubGoal is just a goal with `parent_goal_id`** — NOT a separate table (CEO-locked design
-- contract; see docs/brain/goals/db-driven-specs.md). parent_goal_id is acyclic — a trigger walks
-- the chain on INSERT/UPDATE and rejects a cycle.
--
-- Status ROLLS UP at every tier:
--   public.goal_milestones.status from its child public.specs (any in_progress → in_progress;
--   all shipped/folded → complete; else planned).
--   public.goals.status from its child public.goal_milestones (all complete + currently `greenlit`
--   → `complete`). A `proposed` goal NEVER auto-flips to `greenlit` — the CEO greenlight is the
--   only path (goal-greenlight-button-and-author-writes-db). A `proposed` goal stays `proposed`
--   even when every milestone is complete (rail break otherwise).
--
-- The .md files in docs/brain/goals/ stay authoritative until goal-readers-from-db-retire-parsegoal
-- cuts readers over. This spec only adds the new relations + (in Phase 3) backfills them.
--
-- Workspace-scoped (mirrors public.specs). RLS: any authenticated user reads; service role does all
-- writes (the writers run with service-role creds). No client-side goal writes.

-- ──────────────────────────────────────────────────────────────────────────────
-- public.goals — the goal card (one per goal, self-ref parent for SubGoals)
-- ──────────────────────────────────────────────────────────────────────────────
create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the goal slug (docs/brain/goals/{slug}.md — the file key).
  slug text not null,
  title text not null,
  -- the goal's full body (outcome + why + model + target — the markdown body of the goal page).
  body text not null,
  -- the **Outcome:** line lifted as its own column for board summary cards.
  outcome text,
  -- the **Success metric:** line — the planner's gap-analysis anchor (skills/plan-goal).
  success_metric text,
  -- function slug (DRI) — growth | cmo | retention | cfo | logistics | cs | platform.
  -- Free-text to avoid forcing a hard FK before the functions table catches up.
  owner text not null,
  -- the **Proposed-by:** function — set by director-proposed-goals when a director authored the
  -- goal; null for CEO-authored goals.
  proposer_function text,
  -- NULLABLE self-ref — a SubGoal is just a goal with a parent_goal_id (CEO-locked contract).
  -- on delete cascade so removing a parent goal removes its subtree.
  parent_goal_id uuid references public.goals(id) on delete cascade,
  -- proposed | greenlit | complete | folded. proposed → greenlit is the CEO greenlight; the
  -- rollup trigger only flips greenlit → complete automatically.
  status text not null default 'proposed' check (status in ('proposed','greenlit','complete','folded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Upsert spine: one row per (workspace, slug). The backfill + every future writer go through this
-- onConflict key.
create unique index if not exists goals_ws_slug on public.goals (workspace_id, slug);
-- For the board's nested-goal render (CEO Mode ▸ Fully Autonomous CTO ▸ M1…M5 ▸ specs ▸ phases).
create index if not exists goals_parent_idx on public.goals (parent_goal_id) where parent_goal_id is not null;

alter table public.goals enable row level security;

drop policy if exists goals_select on public.goals;
create policy goals_select on public.goals
  for select to authenticated using (auth.uid() is not null);
drop policy if exists goals_service on public.goals;
create policy goals_service on public.goals
  for all to service_role using (true) with check (true);

-- ──────────────────────────────────────────────────────────────────────────────
-- public.goal_milestones — one row per milestone (a child TABLE)
-- ──────────────────────────────────────────────────────────────────────────────
-- The milestone id is STABLE across reorders + retitles — same lift-a-thing rule as
-- public.spec_phases. Reordering a milestone preserves id via UPSERT-by-position, so any
-- public.specs.milestone_id FK pointing at it survives.
create table if not exists public.goal_milestones (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.goals(id) on delete cascade,
  -- 1-indexed milestone position — the ordering surface. Unique per (goal_id, position).
  position int not null,
  -- e.g. "M1 — The spec body in the DB"
  title text not null,
  -- the markdown block under the `### M{N}` heading.
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
-- specs.milestone_id FK constraint — the column already exists per
-- spec-body-table-and-backfill; this adds the FK now that goal_milestones is real.
-- on delete set null: a milestone going away unattaches its specs (they live on as standalone).
-- ──────────────────────────────────────────────────────────────────────────────
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
-- Rollup: goal_milestones.status follows its child public.specs
-- ──────────────────────────────────────────────────────────────────────────────
-- Any spec in_progress → in_progress; all non-rejected specs shipped|folded → complete; else
-- planned. A milestone with no child specs stays planned.
create or replace function public.roll_up_milestone_status(p_milestone_id uuid)
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
  select status into v_current from public.goal_milestones where id = p_milestone_id;
  if not found then return; end if;

  select
    count(*),
    count(*) filter (where status in ('shipped','folded')),
    count(*) filter (where status = 'in_progress')
  into v_total, v_complete, v_in_progress
  from public.specs where milestone_id = p_milestone_id;

  if v_total = 0 then
    v_next := 'planned';
  elsif v_complete = v_total then
    v_next := 'complete';
  elsif v_in_progress > 0 or v_complete > 0 then
    v_next := 'in_progress';
  else
    v_next := 'planned';
  end if;

  if v_current is distinct from v_next then
    update public.goal_milestones set status = v_next, updated_at = now() where id = p_milestone_id;
  end if;
end $$;

-- Trigger on public.specs: when status or milestone_id changes, recompute the affected milestones.
-- A move that changes milestone_id touches BOTH the old and the new milestone.
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
  -- UPDATE
  if new.milestone_id is not null then
    perform public.roll_up_milestone_status(new.milestone_id);
  end if;
  if old.milestone_id is not null and old.milestone_id is distinct from new.milestone_id then
    perform public.roll_up_milestone_status(old.milestone_id);
  end if;
  return new;
end $$;

drop trigger if exists specs_milestone_rollup on public.specs;
create trigger specs_milestone_rollup
  after insert or delete or update of status, milestone_id on public.specs
  for each row execute function public.specs_milestone_rollup_trigger();

-- ──────────────────────────────────────────────────────────────────────────────
-- Rollup: goals.status follows its child public.goal_milestones
-- ──────────────────────────────────────────────────────────────────────────────
-- IMPORTANT: this NEVER auto-flips proposed → greenlit. The CEO greenlight is the only path
-- (goal-greenlight-button-and-author-writes-db). A proposed goal whose every milestone is complete
-- stays proposed — surfacing the rail violation rather than silently shipping. The rollup only
-- flips greenlit → complete.
create or replace function public.roll_up_goal_status(p_goal_id uuid)
returns void
language plpgsql
as $$
declare
  v_total int;
  v_complete int;
  v_current text;
begin
  select status into v_current from public.goals where id = p_goal_id;
  if not found then return; end if;

  -- folded + proposed are terminal for the rollup. folded is the post-fold archive state; proposed
  -- requires a CEO greenlight before completion is even possible.
  if v_current in ('folded','proposed') then return; end if;

  select count(*), count(*) filter (where status = 'complete')
  into v_total, v_complete
  from public.goal_milestones where goal_id = p_goal_id;

  if v_current = 'greenlit' and v_total > 0 and v_complete = v_total then
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
  after insert or update or delete on public.goal_milestones
  for each row execute function public.goal_milestones_rollup_trigger();

-- ──────────────────────────────────────────────────────────────────────────────
-- parent_goal_id acyclic guard — walk the chain on INSERT/UPDATE, reject cycles
-- ──────────────────────────────────────────────────────────────────────────────
-- The CEO-locked design contract allows reassigning a goal under another goal at any time (one
-- UPDATE goals SET parent_goal_id=…). Cycles must be rejected at the rail or the rollup + board
-- recursion would infinite-loop.
create or replace function public.goals_reject_cycle()
returns trigger
language plpgsql
as $$
declare
  v_ancestor uuid;
  v_steps int := 0;
begin
  if new.parent_goal_id is null then return new; end if;
  if new.parent_goal_id = new.id then
    raise exception 'goals.parent_goal_id cycle: a goal cannot be its own parent (id=%)', new.id;
  end if;

  v_ancestor := new.parent_goal_id;
  while v_ancestor is not null loop
    v_steps := v_steps + 1;
    if v_steps > 64 then
      raise exception 'goals.parent_goal_id chain too deep (>64) — likely cycle from id=%', new.id;
    end if;
    if v_ancestor = new.id then
      raise exception 'goals.parent_goal_id cycle detected — id=% would close a loop', new.id;
    end if;
    select parent_goal_id into v_ancestor from public.goals where id = v_ancestor;
  end loop;
  return new;
end $$;

drop trigger if exists goals_reject_cycle_trigger on public.goals;
create trigger goals_reject_cycle_trigger
  before insert or update of parent_goal_id on public.goals
  for each row execute function public.goals_reject_cycle();
