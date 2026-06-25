-- Goals + milestones in the DB — public.goals + public.goal_milestones + the FK constraint on
-- public.specs.milestone_id (db-driven-specs M5, goals-milestones-tables-and-backfill Phase 1).
-- See docs/brain/specs/goals-milestones-tables-and-backfill.md.
--
-- Stands up the two relations that hold the top two tiers of the Goal → Milestone → Spec → Phase
-- hierarchy as data. goals holds the goal card (slug, title, body, outcome, success_metric, owner,
-- proposer_function, parent_goal_id self-ref nullable, status). goal_milestones holds ONE ROW PER
-- MILESTONE under a goal — a child TABLE (not a jsonb array on goals) so a milestone keeps a STABLE
-- id across reorders, and so public.specs.milestone_id can FK at it.
--
-- A SubGoal is just a goal with a parent_goal_id (CEO-locked design contract) — NOT a separate
-- table. The parent chain is cycle-protected by a trigger below (a goal cannot be its own ancestor).
--
-- Status rolls up at every tier:
--   goal_milestones.status FROM child public.specs.status rows (via row-level trigger on specs)
--   goals.status           FROM child public.goal_milestones.status rows (via trigger on milestones)
-- The proposed→greenlit flip is NEVER automatic — only the CEO action in
-- goal-greenlight-button-and-author-writes-db moves a goal off proposed. The rollup only flips
-- greenlit→complete (so a still-proposed goal cannot silently complete — a rail break).
--
-- Workspace-scoped (mirrors public.specs). RLS: any authenticated user reads; service role does all
-- writes (the writers hold the creds). No client-side goal writes.

-- ──────────────────────────────────────────────────────────────────────────────
-- public.goals — the goal card (one per goal slug, plus SubGoals as parent_goal_id rows)
-- ──────────────────────────────────────────────────────────────────────────────
create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the goal slug (docs/brain/goals/{slug}.md — the file key today; the upsert spine forever).
  slug text not null,
  title text not null,
  -- the full goal body (outcome + why + model + target — what the goal markdown carries today, minus
  -- the auto-generated milestone block which lives in goal_milestones).
  body text not null,
  -- the **Outcome:** paragraph as a separate column for the board summary (parser exposes it today).
  outcome text,
  -- the **Success metric:** line — the planner's gap-analysis anchor (see plan-goal skill).
  success_metric text,
  -- function slug (DRI) — growth | cmo | retention | cfo | logistics | cs | platform. Free-text to
  -- avoid forcing a hard FK before the functions table catches up (mirrors public.specs.owner).
  owner text not null,
  -- the **Proposed-by:** function (set by director-proposed-goals when a director authored the goal;
  -- null for CEO-authored goals).
  proposer_function text,
  -- NULLABLE self-ref. A SubGoal is just a goal with a parent — CEO-locked design contract.
  -- ON DELETE CASCADE: removing a parent goal removes its SubGoal subtree.
  parent_goal_id uuid references public.goals(id) on delete cascade,
  -- 'proposed' — a director (or the CEO) authored it; not yet sanctioned.
  -- 'greenlit' — the CEO greenlit it (the only path off proposed; rail-protected in the rollup).
  -- 'complete' — every milestone is complete (the rollup flips greenlit→complete automatically).
  -- 'folded'   — folded into the brain after completion (M4, future).
  status text not null default 'proposed' check (status in ('proposed','greenlit','complete','folded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Upsert spine: one row per (workspace, slug). The backfill + every writer onConflicts here.
create unique index if not exists goals_ws_slug on public.goals (workspace_id, slug);
-- Board's nested-goal render (CEO Mode ▸ Fully Autonomous CTO ▸ M1…M5 ▸ specs ▸ phases).
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
-- public.goal_milestones — ONE ROW PER MILESTONE under a goal (a child TABLE, not a jsonb array)
-- ──────────────────────────────────────────────────────────────────────────────
-- The milestone id is STABLE across reorders — same lift-a-thing rule public.spec_phases follows.
-- A jsonb-style destroy+recreate would BREAK any public.specs.milestone_id FKs pointing at the
-- milestone (the FK is on delete set null, so a destructive rewrite would silently unattach specs).
create table if not exists public.goal_milestones (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.goals(id) on delete cascade,
  -- 1-indexed milestone position — the ordering surface.
  position int not null,
  -- e.g. "M1 — The spec body in the DB" (the H3 the goal markdown's ### M{N} block carries).
  title text not null,
  -- the milestone description + sub-bullets the goal markdown's ### M{N} block carries.
  body text,
  -- 'planned' / 'in_progress' / 'complete' — rolled up from child public.specs.status.
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
-- public.specs.milestone_id FK constraint — the typed link from spec → milestone
-- ──────────────────────────────────────────────────────────────────────────────
-- The column already exists from spec-body-table-and-backfill — this migration ADDS the foreign-key
-- constraint pointing at public.goal_milestones(id). on delete set null: a standalone spec (function
-- mandate, regression, ad-hoc) keeps milestone_id=null; if a milestone is ever deleted, its specs are
-- unattached rather than removed (the spec keeps its own status + history).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'specs_milestone_id_fkey' and conrelid = 'public.specs'::regclass
  ) then
    alter table public.specs
      add constraint specs_milestone_id_fkey
      foreign key (milestone_id) references public.goal_milestones(id) on delete set null;
  end if;
end $$;

-- ──────────────────────────────────────────────────────────────────────────────
-- parent_goal_id cycle protection — a goal cannot be its own ancestor
-- ──────────────────────────────────────────────────────────────────────────────
-- The CEO-locked design contract allows reassigning a goal under another at any time, so the move
-- is one UPDATE — but cycles must be rejected at the rail. This trigger walks the parent chain on
-- every INSERT/UPDATE that sets parent_goal_id and raises if we'd close a loop.
create or replace function public.goals_reject_parent_cycle()
returns trigger
language plpgsql
as $$
declare
  v_cur uuid;
  v_depth int := 0;
begin
  if new.parent_goal_id is null then
    return new;
  end if;
  if new.parent_goal_id = new.id then
    raise exception 'goals.parent_goal_id cycle: goal % cannot be its own parent', new.id;
  end if;
  v_cur := new.parent_goal_id;
  while v_cur is not null loop
    v_depth := v_depth + 1;
    if v_depth > 64 then
      raise exception 'goals.parent_goal_id cycle: chain depth exceeded for goal %', new.id;
    end if;
    if v_cur = new.id then
      raise exception 'goals.parent_goal_id cycle: goal % would close a loop via %', new.id, new.parent_goal_id;
    end if;
    select parent_goal_id into v_cur from public.goals where id = v_cur;
  end loop;
  return new;
end $$;

drop trigger if exists goals_parent_cycle_check on public.goals;
create trigger goals_parent_cycle_check
  before insert or update of parent_goal_id on public.goals
  for each row execute function public.goals_reject_parent_cycle();

-- ──────────────────────────────────────────────────────────────────────────────
-- Rollup: goal_milestones.status follows child public.specs.status
-- ──────────────────────────────────────────────────────────────────────────────
-- Same rule the brain-roadmap library enforces today, but DB-enforced here — IMPOSSIBLE for a
-- milestone to read complete while a child spec is still in_progress (the goal-side equivalent of
-- the spec-review-agent "shipped with 1 phase" class of bug).
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

  -- count specs in this milestone. shipped + folded count as complete. in_review / planned / deferred
  -- + in_progress do not. rejected isn't a specs status (rejected lives on spec_phases) — so we treat
  -- in_progress as in_progress and everything else as not-yet-complete.
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

-- specs-side trigger: when a spec's status or milestone_id changes, recompute the parent milestone.
-- A spec move (milestone_id change) recomputes BOTH the old and the new milestone.
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
  after insert or delete on public.specs
  for each row execute function public.specs_milestone_rollup_trigger();
drop trigger if exists specs_milestone_rollup_upd on public.specs;
create trigger specs_milestone_rollup_upd
  after update of status, milestone_id on public.specs
  for each row execute function public.specs_milestone_rollup_trigger();

-- ──────────────────────────────────────────────────────────────────────────────
-- Rollup: goals.status follows child public.goal_milestones.status
-- ──────────────────────────────────────────────────────────────────────────────
-- IMPORTANT: the rollup NEVER auto-flips proposed → greenlit. That's the CEO action in
-- goal-greenlight-button-and-author-writes-db. The rollup only flips greenlit → complete when every
-- child milestone is complete. A still-proposed goal stays proposed even if every milestone is
-- complete (the would-be rail break — a goal can't silently complete without ever being greenlit).
-- 'folded' is terminal: the rollup leaves it alone.
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
  -- folded is terminal — never overwritten by the rollup.
  if v_current = 'folded' then return; end if;

  select count(*), count(*) filter (where status = 'complete')
    into v_total, v_complete
    from public.goal_milestones where goal_id = p_goal_id;

  -- only the greenlit → complete flip is automatic. proposed stays proposed (rail).
  if v_current = 'greenlit' and v_total > 0 and v_complete = v_total then
    v_next := 'complete';
  elsif v_current = 'complete' and (v_total = 0 or v_complete < v_total) then
    -- if a previously-complete goal grew a new not-complete milestone, drop it back to greenlit.
    v_next := 'greenlit';
  else
    v_next := v_current;
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
