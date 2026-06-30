-- stale-session-reaper (worker job-lifecycle) — distinguish "alive but long" from "dead", and reap the dead.
--
-- THE GAP (observed live): a `plan` job for goal `growth-director` was claimed in status `building` and
-- never updated again — `updated_at` stayed = `claimed_at` for ~5 hours. A session that dies mid-run (Max
-- usage cap, a crash, a disconnect, a box crash-loop that never reaches reapOrphans) leaves a permanent
-- `building` zombie: the box won't re-claim a `building` row (claim_agent_job only takes queued/queued_resume)
-- and had no in-loop reaper, so the lane is held and the work stalls indefinitely. The startup orphan-reaper
-- (reapOrphans, claimed_at < WORKER_STARTED_AT) only fires on a clean RESTART — a wedged/crash-looping box
-- never gets there, and a cron-enqueued kind (plan/director/…) isn't re-runnable so it would be FAILED, not
-- re-queued. The robust fix is a heartbeat the live session bumps + a periodic reaper keyed on its staleness.
--
-- Two additive, nullable columns on agent_jobs:
--
-- `last_heartbeat_at`: the shared streaming runner (scripts/builder-worker.ts → runBoxSession) bumps this
--   every M minutes WHILE a session is actively emitting stream-json events, and `launch` stamps it on
--   claim. A FRESH value ⇒ the session is alive (even on a long build); a STALE value (> N min, N >> M plus
--   the idle-kill window) ⇒ the session is dead and the row is a zombie → the in-loop reaper re-queues it on
--   a fresh Max account so the lane frees. Distinguishes "alive but long" from "dead" — the whole point.
--
-- `reap_count`: how many times this job has been reaped (re-queued by the stale-session reaper). A job that
--   zombies repeatedly (>= K) is escalated to needs_attention instead of being re-queued forever — a
--   retry cap so a structurally-doomed job can't infinite-loop the reaper. NULL/absent ⇒ never reaped.
--
-- Both NULL on existing rows. No backfill: the reaper falls back to `updated_at` for a pre-migration row
-- that has no heartbeat yet (so a zombie predating this migration is still caught), and a NULL reap_count
-- reads as 0. Free-text/plain columns, same no-CHECK approach as `status`.

alter table public.agent_jobs
  add column if not exists last_heartbeat_at timestamptz,
  add column if not exists reap_count integer not null default 0;

-- Partial index for the reaper's per-tick sweep: it scans only the small set of in-flight rows
-- (building/claimed/queued_resume) and orders by heartbeat staleness. Keeps the ~5s-cadence sweep cheap.
create index if not exists agent_jobs_heartbeat_inflight_idx
  on public.agent_jobs (last_heartbeat_at)
  where status in ('building', 'claimed', 'queued_resume');
