-- ai_channel_config.sol_playbook_selection_active — per-channel opt-in flag for the
-- Sol-chosen playbook branch that retires the signal-based matcher for the Sol cohort.
--
-- Phase 3 of docs/brain/specs/sol-session-chosen-playbook-selection-retire-brittle-triggers.md.
-- When true, unified-ticket-handler's routeExec § 2a fires (Sol names the playbook on the
-- Direction's `plan.playbook_slug` at first-touch and startPlaybook dispatches directly). When
-- false — the safe-rollout stance — the deterministic matcher (§ 2b) still owns the playbook
-- start even for workspaces where sol_first_touch_enabled=true (Sol authors Directions but the
-- signal-matched path continues to dispatch playbooks). This lets an operator ramp the two flags
-- independently and roll back the Sol-chosen path per-channel if it over-triggers without
-- rolling back first-touch entirely.
--
-- Default false so no existing workspace flips over until an operator explicitly enables it.
-- Idempotent (ADD COLUMN IF NOT EXISTS).

ALTER TABLE public.ai_channel_config
  ADD COLUMN IF NOT EXISTS sol_playbook_selection_active boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.ai_channel_config.sol_playbook_selection_active IS
  'When true, unified-ticket-handler''s Sol-chosen playbook branch (routeExec § 2a) dispatches directly from ticket_directions.plan.playbook_slug; when false, the deterministic signal matcher (§ 2b) still owns the playbook start (docs/brain/specs/sol-session-chosen-playbook-selection-retire-brittle-triggers.md Phase 3).';
