-- ai_channel_config.sol_cap_hit_alarm — the workspace-tunable Sol-cap-hit alarm threshold.
--
-- Fix 1 (Phase 4) of docs/brain/specs/sol-runaway-re-session-cap-guardrail.md
-- (the pre-merge spec-test regression fix — Phase 3's alarm threshold column was skipped in the
-- original Phase-2-only session, so the digest composer's cap-hit escalation had nothing to
-- compare against).
--
-- When the digest composer's rolling 7-day count of `ticket_resolution_events` rows with
-- `reasoning='sol:cap-hit'` EXCEEDS this value, [[../libraries/cs-director-digest]] emits an
-- `early_warning` storyline into the next composed digest so June sees it in the digest cycle
-- (per [[../inngest/cs-director-digest-composer]]).
--
-- Default `5` matches the spec's rollout stance: a bursty 6+ cap-hits in 24h (or a slower 6+ in
-- a week) is the "systemic" signal the digest surfaces. Idempotent (ADD COLUMN IF NOT EXISTS).

ALTER TABLE public.ai_channel_config
  ADD COLUMN IF NOT EXISTS sol_cap_hit_alarm integer NOT NULL DEFAULT 5;
