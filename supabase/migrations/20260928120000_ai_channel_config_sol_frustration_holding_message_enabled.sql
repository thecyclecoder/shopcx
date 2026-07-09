-- ai_channel_config.sol_frustration_holding_message_enabled — per-channel toggle for the
-- inline "we're looking into that for you" holding message on the frustration bounce.
--
-- Phase 3 of docs/brain/specs/sol-drift-frustration-detector-and-re-session-router.md.
-- When the inflection detector flags kind='frustration' and the Phase-2 gate calls
-- reSessionSol, the gate ALSO sends a short holding message via stampedSend ONLY when this
-- config is true (drift bounces are silent — the customer doesn't need to be told the AI is
-- re-orienting). Default TRUE per the spec ("we're looking into that for you" is a
-- customer-experience improvement, not a rollout risk); a workspace can turn it off if it
-- prefers a fully silent re-session. Idempotent (ADD COLUMN IF NOT EXISTS).

ALTER TABLE public.ai_channel_config
  ADD COLUMN IF NOT EXISTS sol_frustration_holding_message_enabled boolean NOT NULL DEFAULT true;
