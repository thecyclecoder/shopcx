-- media-buyer-shadow-mode Phase 1 — add `mode` (shadow|armed) to iteration_policies.
--
-- Every FRESHLY activated policy must default to `shadow` (read-only branch — the
-- media-buyer computes the plan but never touches iteration_actions / ad_publish_jobs).
-- Existing `status='active'` rows are the workspaces already running armed today, so
-- they backfill to `mode='armed'`. Subsequent inserts land `shadow` — a Growth Director
-- (or human) explicitly flips a policy to `armed` via the separate flip surface
-- (spec media-buyer-armed-flip-surface, Phase 2 of the goal).
--
-- Two-step default: we ADD COLUMN with DEFAULT 'shadow' so the CHECK is legal for
-- existing rows (they get 'shadow' momentarily), then backfill the already-active
-- rows to 'armed', then re-assert the default is 'shadow' (idempotent — the ADD
-- COLUMN already set it, but a subsequent migration that dropped/changed the default
-- would need to re-apply it, so we spell it out).
--
-- Read by [[../../src/lib/meta/decision-engine.ts]] `loadActivePolicy` (surfaces `mode`
-- to the media-buyer runtime); written by [[../../src/lib/iteration-policy-authoring.ts]]
-- `authorIterationPolicy` (drafts land 'shadow' when the caller omits the override).
-- See docs/brain/specs/media-buyer-shadow-mode.md Phase 1.

alter table public.iteration_policies
  add column if not exists mode text not null default 'shadow'
    check (mode in ('shadow', 'armed'));

-- Backfill the workspaces already running armed today — anything currently `active`
-- keeps its current behavior (no silent read-only flip on live media-buyer loops).
update public.iteration_policies
  set mode = 'armed'
  where status = 'active' and mode <> 'armed';

-- Re-assert the default as `shadow` (defensive — the column already carries it, but a
-- future migration that touched the default would want to re-establish this contract).
alter table public.iteration_policies
  alter column mode set default 'shadow';
