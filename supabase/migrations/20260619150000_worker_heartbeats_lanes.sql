-- worker_heartbeats lane detail (build-box-status-view Phase 1): enrich the box worker's heartbeat with
-- the full lane picture so the dashboard can render a live build-box view — how many lanes exist, how
-- many are in use, and what each in-flight lane is building right now — without SSH.
-- See docs/brain/specs/build-box-status-view.md + docs/brain/tables/worker_heartbeats.md.

alter table public.worker_heartbeats
  add column if not exists build_lanes integer,                      -- total build/plan lanes (MAX_CONCURRENT)
  add column if not exists fold_lanes integer,                       -- total fold lanes (MAX_FOLD)
  add column if not exists lanes jsonb not null default '[]'::jsonb; -- [{ kind, job_id, spec_slug, since }] per in-flight lane
