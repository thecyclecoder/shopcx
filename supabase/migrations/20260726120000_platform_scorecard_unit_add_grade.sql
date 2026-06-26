-- Expand platform_scorecard_snapshots.unit CHECK to include 'grade'
-- (docs/brain/specs/devops-kpi-review-sdk-and-data-fix.md, Phase 2 — Fix the grade-as-ratio bug).
--
-- Phase 2 adds 'grade' to src/lib/agents/platform-scorecard.ts MetricUnit and switches
-- worker_grade_rollup + director_call_grade (both 1–10 scales) from unit='ratio' to unit='grade',
-- so the display side renders them as "X.X / 10" instead of an 850%-style percent. The engine's
-- UPSERT into platform_scorecard_snapshots would be rejected by the existing CHECK
-- (count|ratio|hours|pct) until 'grade' joins the enum — this migration is that.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + add the new one. Re-runnable.

alter table public.platform_scorecard_snapshots
  drop constraint if exists platform_scorecard_snapshots_unit_check;

alter table public.platform_scorecard_snapshots
  add constraint platform_scorecard_snapshots_unit_check
  check (unit in ('count', 'ratio', 'hours', 'pct', 'grade'));
