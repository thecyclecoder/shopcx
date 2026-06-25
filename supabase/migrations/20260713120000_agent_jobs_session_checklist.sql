-- box-session-transparency Phase 1 — every box session writes its plan + live progress to the job row.
--
-- A box session today is a black box: you see `building…` and, at the end, a log_tail. You can't see
-- what the agent PLANNED to do, where it is, or why. This adds two additive, nullable columns to
-- agent_jobs so the shared streaming runner (scripts/builder-worker.ts → runBoxSession) can stream the
-- agent's TodoWrite checklist + the current one-line note onto the row in real time — surfaced on the
-- box card (the un-black-boxing surface, Phase 2) and preserved for after-the-fact session review
-- (Phase 3, pairs with the grading loop).
--
-- `session_checklist`: [{step, status:'pending'|'in_progress'|'done', note}] — the live plan.
-- `session_note`: the single most-recent human one-liner, for the compact chip on the card.
--
-- Free-text status strings (no CHECK) so a new state can land code-side without a schema bump, same
-- approach as the existing `status` column. Both NULL on existing rows — pre-migration jobs simply
-- have no checklist (the runner never wrote one). No backfill needed.

alter table public.agent_jobs
  add column if not exists session_checklist jsonb,
  add column if not exists session_note text;
