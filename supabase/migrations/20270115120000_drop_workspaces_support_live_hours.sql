-- Revert the software-mode live-hours handoff (spec: revert-software-mode-live-hours-handoff).
--
-- The CEO dropped the live-hours concept from the ShopGrowth support goal on 2026-11-12
-- ("remove that concept for now, we can think about live hours another time"), a few minutes
-- after the originating spec (#3575) had already merged. This forward migration removes the
-- column that #3575's 20270114120000_workspaces_support_live_hours.sql added. That add
-- migration stays in history (never delete an applied migration) — this one undoes its effect.
--
-- The column was added minutes before the revert and no UI ever persisted a value to it before
-- it was pulled (the widget-settings editor is removed in the same revert), so it is NULL on
-- every row and the drop destroys no data. The goal's software-mode-workspace-switch spec will
-- reintroduce support-mode config on a clean base.

ALTER TABLE workspaces
  DROP COLUMN IF EXISTS support_live_hours;  -- reversible: column added minutes earlier (20270114120000), NULL on every row, no UI ever persisted a value — dropping it loses no data
