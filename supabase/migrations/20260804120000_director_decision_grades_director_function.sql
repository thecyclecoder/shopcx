-- director_decision_grades.director_function — the function slug the graded call belongs to
-- (docs/brain/specs/growth-adopt-meta-iteration-engine.md, Phase 2). Before this column the grade store
-- was implicitly Platform-only (the only live director); now that Growth is the second live director
-- (growth-director-agent), we need to stamp WHICH director the call belongs to so the per-director
-- report + the per-director leash-loosen/tighten recommendations don't blur the two pools.
--
-- Backfill: every existing row predates the Growth Director, so default 'platform' is correct.
-- Going forward the grader stamps the column from approval_decisions.routed_to_function for an
-- auto-approval row, and from the goal's owner for a goal-escort row.
--
-- Idempotent (IF NOT EXISTS) — apply: npx tsx scripts/apply-director-decision-grades-director-function-migration.ts.

alter table public.director_decision_grades
  add column if not exists director_function text not null default 'platform';

-- Per-director report + trend lookup — the grades route filters by (workspace_id, director_function).
create index if not exists director_decision_grades_dir_fn_idx
  on public.director_decision_grades (workspace_id, director_function, created_at desc);
