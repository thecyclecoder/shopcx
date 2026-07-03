-- derive-rollup-status P3 (step 5) — make rollup status PURELY DERIVED.
--
-- The three rollup ladders (spec_phases → specs.status, specs → goal_milestones.status,
-- goal_milestones → goals.status) were maintained by DB triggers. The READERS already derive every one of
-- them at read time:
--   - getRoadmap derives spec status from its phases  (brain-roadmap.ts `rollupPhaseStatus` / `deriveStatus`)
--   - getGoals derives milestone completion from child specs, and goal `complete` from all-milestones-complete
--     (brain-roadmap.ts `milestoneRowToCard` / `goalRowToCard`)
-- so dropping these triggers changes NO displayed status. We keep:
--   - specs.status  — the explicit lifecycle override (in_review / deferred / folded); NOT derivable. The
--     deriving readers ignore any stale rollup value it still carries.
--   - goals.status  — the CEO-greenlight input (proposed / greenlit / folded); `complete` is derived.
-- and DROP entirely:
--   - goal_milestones.status — purely planned/in_progress/complete, fully derivable from child specs, with
--     NO explicit/terminal state of its own. Nothing reads it after this migration.
--
-- Object provenance (where each trigger + function was created):
--   spec_phases_rollup          — 20260713120000_specs_and_spec_phases.sql:186  (fn spec_phases_rollup_trigger() :167)
--   specs_deferred_rollup       — 20260713120000_specs_and_spec_phases.sql:204  (fn specs_deferred_rollup_trigger() :192)
--   specs_milestone_rollup      — 20260725130000_goals_and_goal_milestones.sql:192 (fn specs_milestone_rollup_trigger() :167)
--   goal_milestones_rollup      — 20260725130000_goals_and_goal_milestones.sql:260 (fn goal_milestones_rollup_trigger() :243)
--   roll_up_spec_status(uuid)   — 20260713120000_specs_and_spec_phases.sql (writes specs.status; called by the two specs triggers)
--   roll_up_milestone_status(uuid) — 20260725130000_goals_and_goal_milestones.sql:131 (READS goal_milestones.status — drop BEFORE the column)
--   roll_up_goal_status(uuid)   — 20260725130000_goals_and_goal_milestones.sql:203 (READS goal_milestones.status — drop BEFORE the column)
--
-- Order matters: drop the triggers + functions that READ goal_milestones.status BEFORE dropping the column.

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. Drop the rollup triggers (no rollup status is ever auto-written after this).
-- ──────────────────────────────────────────────────────────────────────────────
drop trigger if exists spec_phases_rollup on public.spec_phases;
drop trigger if exists specs_deferred_rollup on public.specs;
drop trigger if exists specs_milestone_rollup on public.specs;
drop trigger if exists goal_milestones_rollup on public.goal_milestones;

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. Drop the now-orphaned rollup functions (no remaining trigger or app caller).
--    The two that READ goal_milestones.status (roll_up_milestone_status / roll_up_goal_status) MUST go
--    before the column drop in step 3 — they're dropped here, ahead of it.
-- ──────────────────────────────────────────────────────────────────────────────
drop function if exists public.spec_phases_rollup_trigger();
drop function if exists public.specs_deferred_rollup_trigger();
drop function if exists public.specs_milestone_rollup_trigger();
drop function if exists public.goal_milestones_rollup_trigger();
drop function if exists public.roll_up_spec_status(uuid);
drop function if exists public.roll_up_milestone_status(uuid);
drop function if exists public.roll_up_goal_status(uuid);

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. Drop goal_milestones.status — purely derivable from child specs, nothing reads it now.
-- ──────────────────────────────────────────────────────────────────────────────
alter table public.goal_milestones drop column if exists status;   -- reversible: derived from child specs, no reader after rollup retirement
