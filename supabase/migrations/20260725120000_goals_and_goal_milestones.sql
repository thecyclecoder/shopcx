-- goals + goal_milestones — the top two tiers of the [[../project-management|Goal → Milestone → Spec → Phase]]
-- hierarchy as data (db-driven-specs M5). Today `getGoals` ([[../libraries/brain-roadmap]] L1004) reads
-- `docs/brain/goals/*.md` directly; flipping the Status line is a markdown commit + Vercel deploy. Same
-- mirroring disease that bit `spec_card_state`. This migration stands up the two relations so subsequent
-- specs can cut readers / writers / the CEO greenlight button over (`goal-greenlight-button-and-author-writes-db`,
-- `goal-readers-from-db-retire-parsegoal`, `goal-fold-from-db-row`).
--
-- A `SubGoal` is just a goal with a `parent_goal_id` — NOT a separate table. The CEO-locked design
-- contract is one self-referential relation. Most goals have no parent; a goal CAN be re-assigned
-- under another goal at any time via a single UPDATE (cycles rejected at the rail).
--
-- Status at every tier ROLLS UP from children (impossible to stick at `complete` while a child is open):
--   goal_milestones.status ← rollup of child specs.status (the trigger lives on public.specs once that
--     table exists per [[spec-body-table-and-backfill]]; the function `roll_up_milestone_status` is
--     authored here for that future trigger to call).
--   goals.status            ← rollup of child goal_milestones.status, BUT a `proposed` goal NEVER
--     auto-flips to `complete` — only a CEO greenlight (the `goal-greenlight-button-and-author-writes-db`
--     button) moves `proposed → greenlit`, and only then can the rollup move it to `complete`.
--
-- DEFERRED to a follow-up migration once [[spec-body-table-and-backfill]] ships (the `public.specs`
-- table doesn't exist on main yet):
--   - the FK constraint on `public.specs.milestone_id → public.goal_milestones(id) on delete set null`
--   - the row-level trigger on `public.specs` (after update of `status` or `milestone_id`) that calls
--     `roll_up_milestone_status` — without it, milestone status only moves when a writer calls the
--     function directly. Once specs ships, a tiny follow-up migration adds the FK + trigger.
--
-- RLS: enabled on both; any authenticated user reads (mirrors spec_card_state); service role does all
-- writes. No client-side goal writes.

------------------------------------------------------------------
-- public.goals
------------------------------------------------------------------

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the docs/brain/goals/{slug}.md key — the upsert spine.
  slug text not null,
  title text not null,
  -- the goal's full body the markdown carries today (outcome + why + model + target + decomposition seed).
  body text not null,
  -- the one-paragraph **Outcome:** line as a separate column for the board summary surface.
  outcome text,
  -- the **Success metric:** line — the planner's gap-analysis anchor (per [[../skills/plan-goal]]).
  success_metric text,
  -- the DRI function slug — growth ｜ cmo ｜ retention ｜ cfo ｜ logistics ｜ cs ｜ platform.
  owner text not null,
  -- the **Proposed-by:** function (set by [[../specs/director-proposed-goals]] when a director
  -- authored the goal as a proposal). NULL for a CEO-authored goal.
  proposer_function text,
  -- self-ref: a SubGoal is just a goal with a parent. NULLABLE. ON DELETE CASCADE so deleting
  -- a parent removes its subgoals (matches the markdown semantics — a subgoal lives under its
  -- parent in the brain). Cycle protection is enforced by a trigger below.
  parent_goal_id uuid references public.goals(id) on delete cascade,
  -- DB-driven status (never the markdown `**Status:**` line). The CEO greenlight button is the
  -- ONLY path from `proposed` → `greenlit` (per [[../specs/goal-greenlight-button-and-author-writes-db]]).
  -- `folded` is the M4-fold preserved-row state (per [[../specs/goal-fold-from-db-row]]).
  status text not null default 'proposed' check (status in ('proposed','greenlit','complete','folded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Upsert spine — the backfill UPSERTs by (workspace_id, slug) and re-runs are no-ops.
create unique index if not exists goals_ws_slug
  on public.goals (workspace_id, slug);

-- Board's nested-goal render walks parent_goal_id (CEO Mode ▸ M1…M5 ▸ specs ▸ phases).
create index if not exists goals_parent_idx
  on public.goals (parent_goal_id);

create index if not exists goals_ws_idx
  on public.goals (workspace_id);

------------------------------------------------------------------
-- public.goal_milestones
------------------------------------------------------------------

create table if not exists public.goal_milestones (
  -- STABLE across reorders — same lift-a-thing rule as `spec_phases` (a milestone can be re-positioned
  -- without losing the `public.specs.milestone_id` FKs pointing at it). Destroy+recreate would silently
  -- unattach specs (the FK is `on delete set null`).
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.goals(id) on delete cascade,
  -- 1-indexed display order.
  position int not null,
  -- e.g. "M1 — The spec body in the DB".
  title text not null,
  -- the milestone description + sub-bullets the goal markdown's `### M{N}` block carries.
  body text,
  -- Rolled up from child specs.status (any in_progress → in_progress; all shipped|folded → complete;
  -- else planned). The trigger that fires the rollup lives on `public.specs` and is added by the
  -- follow-up migration once [[spec-body-table-and-backfill]] ships (see header comment).
  status text not null default 'planned' check (status in ('planned','in_progress','complete')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Unique (goal, position) — the lift-a-milestone primitive preserves id while updating position.
create unique index if not exists goal_milestones_goal_position
  on public.goal_milestones (goal_id, position);

create index if not exists goal_milestones_goal_idx
  on public.goal_milestones (goal_id);

------------------------------------------------------------------
-- updated_at touch triggers
------------------------------------------------------------------

create or replace function public.goals_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists goals_touch_updated_at on public.goals;
create trigger goals_touch_updated_at
  before update on public.goals
  for each row execute function public.goals_touch_updated_at();

create or replace function public.goal_milestones_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists goal_milestones_touch_updated_at on public.goal_milestones;
create trigger goal_milestones_touch_updated_at
  before update on public.goal_milestones
  for each row execute function public.goal_milestones_touch_updated_at();

------------------------------------------------------------------
-- parent_goal_id acyclic check
--
-- A goal CANNOT be its own ancestor. The CEO-locked design allows re-assigning a goal under another
-- goal at any time (a single UPDATE) so we enforce acyclicity at the rail. Walks the parent chain
-- on INSERT/UPDATE and RAISEs on a cycle. The chain is small (a goal nests a handful of levels at
-- most) so a recursive walk is cheap.
------------------------------------------------------------------

create or replace function public.goals_check_acyclic_parent()
returns trigger as $$
declare
  ancestor uuid := new.parent_goal_id;
  hops int := 0;
begin
  if new.parent_goal_id is null then
    return new;
  end if;
  if new.parent_goal_id = new.id then
    raise exception 'goals.parent_goal_id cycle: goal % cannot be its own parent', new.id;
  end if;
  while ancestor is not null loop
    if ancestor = new.id then
      raise exception 'goals.parent_goal_id cycle: setting parent of % would close a loop', new.id;
    end if;
    hops := hops + 1;
    if hops > 32 then
      raise exception 'goals.parent_goal_id cycle: parent chain depth exceeded for %', new.id;
    end if;
    select parent_goal_id into ancestor from public.goals where id = ancestor;
  end loop;
  return new;
end;
$$ language plpgsql;

drop trigger if exists goals_check_acyclic_parent on public.goals;
create trigger goals_check_acyclic_parent
  before insert or update of parent_goal_id on public.goals
  for each row execute function public.goals_check_acyclic_parent();

------------------------------------------------------------------
-- Rollup functions
--
-- `roll_up_milestone_status(milestone_id)` reads public.specs rows for the milestone and rolls up:
--   any `in_progress` → `in_progress`
--   all `shipped`|`folded` → `complete`
--   else `planned`
-- The function is plpgsql so name resolution is deferred to call time — it is harmless to define
-- before `public.specs` exists; calls will fail until the blocker ships and the FK + trigger land.
--
-- `roll_up_goal_status(goal_id)` reads public.goal_milestones rows for the goal and rolls up:
--   all `complete` AND current status = `greenlit` → flip to `complete`
--   any `in_progress` AND current status = `greenlit` → STAY `greenlit` (no `in_progress` slot at the goal tier)
--   else: no-op
-- A `proposed` goal NEVER auto-flips to `complete` — that would skip the CEO greenlight, the explicit
-- rail (`goal-greenlight-button-and-author-writes-db`). A `folded` goal is terminal.
------------------------------------------------------------------

create or replace function public.roll_up_milestone_status(p_milestone_id uuid)
returns void as $$
declare
  total int;
  in_prog int;
  done int;
  new_status text;
begin
  select
    count(*)::int,
    count(*) filter (where status = 'in_progress')::int,
    count(*) filter (where status in ('shipped','folded'))::int
  into total, in_prog, done
  from public.specs
  where milestone_id = p_milestone_id;

  if total = 0 then
    return;
  end if;
  if in_prog > 0 then
    new_status := 'in_progress';
  elsif done = total then
    new_status := 'complete';
  else
    new_status := 'planned';
  end if;

  update public.goal_milestones
     set status = new_status
   where id = p_milestone_id
     and status is distinct from new_status;
end;
$$ language plpgsql;

create or replace function public.roll_up_goal_status(p_goal_id uuid)
returns void as $$
declare
  total int;
  done int;
  cur_status text;
begin
  select status into cur_status from public.goals where id = p_goal_id;
  -- proposed: needs an explicit CEO greenlight before any rollup applies.
  -- folded: terminal.
  if cur_status is null or cur_status in ('proposed','folded') then
    return;
  end if;
  select
    count(*)::int,
    count(*) filter (where status = 'complete')::int
  into total, done
  from public.goal_milestones
  where goal_id = p_goal_id;
  if total = 0 then
    return;
  end if;
  if done = total and cur_status = 'greenlit' then
    update public.goals set status = 'complete' where id = p_goal_id and status = 'greenlit';
  end if;
end;
$$ language plpgsql;

------------------------------------------------------------------
-- goal_milestones → goals rollup trigger
------------------------------------------------------------------

create or replace function public.goal_milestones_after_status_change()
returns trigger as $$
begin
  if (tg_op = 'INSERT') or (new.status is distinct from old.status) then
    perform public.roll_up_goal_status(new.goal_id);
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists goal_milestones_rollup_to_goal on public.goal_milestones;
create trigger goal_milestones_rollup_to_goal
  after insert or update of status on public.goal_milestones
  for each row execute function public.goal_milestones_after_status_change();

------------------------------------------------------------------
-- RLS
------------------------------------------------------------------

alter table public.goals enable row level security;
alter table public.goal_milestones enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'goals' and policyname = 'goals_select') then
    create policy goals_select on public.goals
      for select to authenticated using (auth.uid() is not null);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'goals' and policyname = 'goals_service') then
    create policy goals_service on public.goals
      for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'goal_milestones' and policyname = 'goal_milestones_select') then
    create policy goal_milestones_select on public.goal_milestones
      for select to authenticated using (auth.uid() is not null);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'goal_milestones' and policyname = 'goal_milestones_service') then
    create policy goal_milestones_service on public.goal_milestones
      for all to service_role using (true) with check (true);
  end if;
end $$;
