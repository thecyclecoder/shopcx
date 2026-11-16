-- workspace-feature-access Phase 1 — per-workspace feature allow-list.
--
-- Each workspace carries a list of enabled dashboard features. NULL means "every feature"
-- (the Superfoods default), so every existing workspace keeps everything on backfill.
-- Feature keys are the first path segment under /dashboard (tickets, customers, orders, …);
-- 'settings' is always enabled regardless (see src/lib/workspace-features.ts).
alter table public.workspaces
  add column if not exists enabled_features text[];

-- ShopGrowth starts with Tickets only (CEO 2026-11-12). Idempotent: re-running simply
-- re-asserts the allow-list. Settings stays visible (always-on in hasWorkspaceFeature).
update public.workspaces
  set enabled_features = array['tickets']
  where id = 'f4796217-9dcb-4c7b-b405-6e00f01a2a70';
