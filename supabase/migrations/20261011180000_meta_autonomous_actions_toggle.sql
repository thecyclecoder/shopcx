-- The on/off switch for the storefront-iteration decision-engine's 4a AUTONOMOUS ad actions
-- (pause/scale/replenish on live Meta objects) — CEO 2026-07-11. It was uncoordinated with the media
-- buyer (Bianca), who now owns live ad actions. Default OFF so only Bianca touches live campaigns; the
-- engine's 4b recommendations + the scorecards + the executor keep running (Bianca depends on them).
-- Flip on/off with: update public.workspaces set meta_autonomous_actions_enabled = <bool> where id = ...
alter table public.workspaces
  add column if not exists meta_autonomous_actions_enabled boolean not null default false;

comment on column public.workspaces.meta_autonomous_actions_enabled is
  'On/off for the meta decision-engine 4a autonomous ad actions (pause/scale/replenish). Default false — Bianca (media buyer) owns live ad actions. Read by decision-engine.isMetaAutonomousActionsEnabled.';
