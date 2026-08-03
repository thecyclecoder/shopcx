-- spec-goal-branch-pm-flow M5 — add public.goals.is_parent (parent-goal exemption flag).
-- See docs/brain/specs/spec-goal-branch-pm-flow.md §M5 (part 4: parent-goal exemption).
--
-- BACKGROUND. M5 is the atomic goal→main promotion: when EVERY member spec of a goal is on its goal branch
-- (goal_branch_sha set) AND the goal branch is GREEN, `promoteCompleteGoalsToMain` merges goal/{goal-slug} →
-- main in ONE merge and flips every member phase to shipped (the only shipped-writer).
--
-- A PARENT goal (e.g. CEO Mode — it CONTAINS sub-goals via goals.parent_goal_id, it has no direct buildable
-- specs of its own) must NOT atomic-promote as a whole: there is no goal/{parent-slug} branch to merge, and
-- its sub-goals promote INDEPENDENTLY on their own completion. Force-promoting a parent would try to merge a
-- nonexistent / empty goal branch and stamp nothing — at best a no-op, at worst a confusing failure. So M5
-- SKIPS parent goals in promoteCompleteGoalsToMain; each child goal promotes on its own.
--
-- DETECTION. A goal is treated as a parent (exempt) if ANY of:
--   (a) is_parent = true (THIS explicit flag — the clean, intentional override), OR
--   (b) it is referenced by ≥1 other goal's parent_goal_id (it HAS child goals), OR
--   (c) it has no buildable member specs (no spec linked through its milestones).
-- (b)+(c) are structural fallbacks so the exemption works even before anyone sets the flag; (a) is the
-- explicit, future-proof signal (CEO-mode isn't built as a parent yet, but the flag is ready so it can never
-- be force-promoted). isGoalParentExempt() in goals-table.ts ORs the three.
--
-- Nullable-with-default (NOT NULL DEFAULT false) + idempotent (ADD COLUMN IF NOT EXISTS). No backfill of the
-- flag itself — the structural (b)/(c) fallbacks already exempt the existing CEO-mode parent; the flag is set
-- explicitly going forward (setGoalIsParent). No trigger interaction (the rollup triggers were dropped in
-- 20260725160000 — goal completion is purely read-time derived from child specs).

alter table public.goals
  add column if not exists is_parent boolean not null default false;

comment on column public.goals.is_parent is
  'spec-goal-branch-pm-flow M5 — explicit parent-goal flag. A parent goal CONTAINS sub-goals (via '
  'parent_goal_id) and has no direct buildable specs, so it MUST NOT atomic-promote to main as a whole — its '
  'child goals each promote independently on their own completion. promoteCompleteGoalsToMain SKIPS a goal '
  'when isGoalParentExempt() is true (is_parent=true OR it has child goals OR it has no buildable specs). '
  'CEO Mode is the canonical parent (exempt today via the has-children fallback); this flag is the explicit, '
  'future-proof override.';
