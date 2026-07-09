-- sol_resession_cap — the anti-runaway guardrail on Sol re-sessions.
--
-- Phase 1 of docs/brain/specs/sol-runaway-re-session-cap-guardrail.md
-- (parent goal: sol-ticket-direction-then-cheap-execution → M5
-- "Cost + quality measurement + the guardrails").
--
-- Frustration always bounces to Sol (per sol-drift-frustration-detector-and-re-session-router),
-- which without a cap can loop indefinitely on a pathological ticket — burning cost and never
-- converging. This migration adds:
--
--   1. ticket_directions.resession_count integer NOT NULL DEFAULT 0
--        — a per-ticket counter incremented each time the router supersedes the live Direction
--          and dispatches a fresh Sol box session (Phase 2 of this spec). Zero on the first
--          Direction; N after N re-sessions.
--
--   2. ai_channel_config.sol_max_resessions integer NULL DEFAULT 3
--        — a workspace-tunable ceiling. NULL = uncapped (per the parent goal's language
--          "never rewards ... but bounds re-sessions" — a workspace can opt out). Default 3
--          matches the spec's rollout stance. When the router (Phase 2) sees
--          Direction.resession_count >= sol_max_resessions, it skips the agent_jobs insert
--          and escalates the ticket to the routine lane instead.
--
-- Both columns are idempotent (ADD COLUMN IF NOT EXISTS).
--
-- Verification: on \d ticket_directions, expect resession_count integer NOT NULL DEFAULT 0;
-- on \d ai_channel_config, expect sol_max_resessions integer NULL DEFAULT 3.

ALTER TABLE public.ticket_directions
  ADD COLUMN IF NOT EXISTS resession_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.ai_channel_config
  ADD COLUMN IF NOT EXISTS sol_max_resessions integer DEFAULT 3;
