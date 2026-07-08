-- worker_heartbeats.lane_groups (build-box-page-reflects-real-per-lane-group-usage Phase 1):
-- The box worker runs each kind in its OWN dedicated lane with its own cap (MAX_CONCURRENT for
-- the build/plan pool, MAX_TICKET_HANDLE/MAX_TICKET_ANALYZE/MAX_CS_DIRECTOR_CALL for customer
-- service, MAX_PLATFORM_DIRECTOR + MAX_DIRECTOR_COACH for director, MAX_FOLD for fold, …). The
-- pre-existing build_lanes/fold_lanes scalar columns only carry two of those caps, which is
-- why /dashboard/roadmap/box could render nonsense like "13/10 in use" — it was lumping every
-- non-fold in-flight lane against the build/plan pool cap.
--
-- lane_groups carries the FULL per-group cap picture as a jsonb map so the box page + BoxChip
-- can render each group (build_plan / customer_service / director / fold / other) against its
-- OWN cap. Shape:
--   { <group_key>: { cap: <integer>, kinds: [<agent_jobs.kind>, …] }, … }
-- Nullable — the older heartbeat rows won't have it; the page falls back to build_lanes/
-- fold_lanes for those.
--
-- See docs/brain/specs/build-box-page-reflects-real-per-lane-group-usage.md.

alter table public.worker_heartbeats
  add column if not exists lane_groups jsonb;
