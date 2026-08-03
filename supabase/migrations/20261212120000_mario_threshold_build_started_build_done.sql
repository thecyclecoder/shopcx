-- Add the `build_started -> build_done` threshold row to mario_thresholds.
--
-- Spec: docs/brain/specs/build-a-build-that-never-finishes-is-visible-to-mario.md
-- Phase 1.
--
-- Why: Mario's SLA table only carried the finish-side pair build_done →
-- phase_shipped, so a build that STARTS and never emits build_done falls
-- outside every threshold and never opens a measurable transition. The M3
-- detector's happy-path scan (src/lib/mario.ts `evaluateStalledSpecs`) reads
-- thresholds generically already — one iteration per row via `readThresholds`
-- — so adding this row is sufficient to bring the previously-unwatched
-- transition into the same reactive loop as every other stall class.
--
-- SLA choice: 90 min (5_400_000 ms). The worker's own BUILD_HARD_CAP_MS is 60
-- min (scripts/builder-worker.ts) — a build that has emitted no build_done at
-- 60 min is definitionally dead — and MARIO_FAILED_BUILD_GRACE_MS layers a
-- 20-min recovery grace on top of the failure signal, so 90 min sits
-- comfortably past the tail of any legitimate live build without racing the
-- failed-build source (which fires at hard-cap + 20 min = 80 min for a job
-- the worker itself flipped to `failed`). The three currently-stalled specs
-- called out in the spec are ~40 h silent — 80× over — so no plausibly
-- tighter SLA is needed to catch them.
--
-- Idempotent via the unique (workspace_id, from_event, to_event) constraint —
-- re-applying is a no-op on rows already present, and a per-workspace tuning
-- of sla_ms made after the first apply is never clobbered.
insert into public.mario_thresholds (workspace_id, from_event, to_event, sla_ms, min_count)
select w.id, 'build_started'::text, 'build_done'::text, 5400000::bigint, 1::int
from public.workspaces w
on conflict (workspace_id, from_event, to_event) do nothing;
