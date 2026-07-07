-- ai_channel_config.sol_first_touch_enabled — per-channel opt-in flag for Sol's first-touch box session.
--
-- Phase 3 of docs/brain/specs/sol-ticket-direction-artifact-and-first-touch-box-session.md.
-- When true (and the inbound event is is_new_ticket), the unified-ticket-handler skips the inline
-- Sonnet Step 2e path: (a) sends a short per-channel ack via the existing send() wrapper (stamping
-- shipped_at on the ack's ticket_resolution_events row), (b) enqueues an agent_jobs row
-- kind='ticket-handle' that runs Sol's first-touch box session on Max, and (c) returns without
-- dispatching the orchestrator. Fraud + agent_intervened checks still win — they are evaluated
-- BEFORE this branch, per the spec's verification bullet 4.
--
-- Default false so rollout is opt-in per-workspace/per-channel — no existing workspace flips over
-- until an operator explicitly turns it on. Idempotent (ADD COLUMN IF NOT EXISTS).

ALTER TABLE public.ai_channel_config
  ADD COLUMN IF NOT EXISTS sol_first_touch_enabled boolean NOT NULL DEFAULT false;
