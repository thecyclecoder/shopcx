-- spec-goal-branch-pm-flow M4 — add public.specs.goal_branch_sha (goal-branch integration marker).
-- See docs/brain/specs/spec-goal-branch-pm-flow.md §M4.
--
-- BACKGROUND. M1–M3 built the per-spec branch flow: every phase of a spec accumulates onto ONE persistent
-- `claude/build-{slug}` branch (build_sha provenance), and a spec becomes `isSpecPromoteEligible` once it's
-- fully accumulated + spec-test-green + security-green on that branch. M4 wires those promote-eligible
-- GOAL-BOUND specs into a per-goal integration branch `goal/{goal-slug}`: when a goal-bound spec is promote-
-- eligible its `claude/build-{slug}` branch is merged into `goal/{goal-slug}` (created from origin/main by the
-- first spec), sequenced by blocked_by so dependencies land first. The dependent spec then BUILDS off the
-- goal branch (so it sees its already-merged dependencies' code).
--
-- goal_branch_sha (THIS migration) — the goal-branch merge commit SHA recorded the moment a spec's branch
-- merges into its goal branch (stampSpecGoalBranchSha). It is the durable "this spec is ON the goal branch"
-- marker:
--   - The claim-time blocked_by gate (scripts/builder-worker.ts evaluateClaimTimeBuildGate) reads it to
--     CLEAR a GOAL-MATE blocker — a goal-mate never ships to main until the whole goal promotes atomically
--     (M5), so a goal-mate blocker is cleared when it's on the goal branch (goal_branch_sha set), NOT when
--     shipped. An EXTERNAL blocker (one-off / a different goal) still clears only when shipped (on main).
--   - M5 (atomic-goal-promotion-to-main) reads "every spec in the goal has goal_branch_sha" to detect a
--     goal-complete state, then does the atomic goal→main merge + flips each build_sha'd phase to shipped.
--     M4 leaves this column + the goalBranchState() read helper as the clean seam M5 consumes; M4 introduces
--     NOTHING that merges the goal branch to main or writes status='shipped'.
--
-- Distinct from spec_phases.build_sha (per-PHASE spec-branch build provenance) and spec_phases.merge_sha /
-- status='shipped' (the M5 main-promotion stamp). goal_branch_sha is the SPEC-level goal-branch integration
-- marker between the two: built-on-spec-branch → on-goal-branch (HERE) → shipped-to-main (M5).
--
-- Nullable + idempotent (ADD COLUMN IF NOT EXISTS). No backfill: a spec gets a goal_branch_sha only when its
-- branch merges onto a goal branch going forward. No trigger interaction — the rollup triggers were dropped
-- in 20260725160000 (status is purely read-time derived now), so this column is inert to status derivation
-- (a goal-branched-but-unpromoted spec still reads in_progress from its phases, not shipped).

alter table public.specs
  add column if not exists goal_branch_sha text;

comment on column public.specs.goal_branch_sha is
  'spec-goal-branch-pm-flow M4 — the goal/{goal-slug} merge commit SHA where this spec''s claude/build-{slug} '
  'branch was merged onto its goal branch (stampSpecGoalBranchSha). The durable "on the goal branch" marker: '
  'the claim-time blocked_by gate clears a GOAL-MATE blocker when this is set (a goal-mate never ships to main '
  'until M5''s atomic goal promotion), and M5 reads "every spec in the goal has goal_branch_sha" to detect '
  'goal-complete. Distinct from spec_phases.merge_sha (the M5 main-promotion stamp). Null = not yet on the goal branch.';
