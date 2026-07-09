-- media_buyer_test_cohorts sensor-trust thresholds (media-buyer-sensor-trust-probe
-- Phase 1, additive). Adds three owner-editable band thresholds so the cohort
-- owner authors the green/yellow/red bands the Phase 2 sensor-trust-probe reads
-- when it computes a media_buyer_sensor_trust row. All three columns are
-- NULLABLE — the Phase 2 probe falls back to a code-level default when a value
-- is missing, so an already-seeded cohort keeps working.

alter table public.media_buyer_test_cohorts
  add column if not exists green_min_coverage numeric,
  add column if not exists yellow_min_coverage numeric,
  add column if not exists max_unresolved_share numeric;
