-- Close the cross-tenant read gap on public.sonnet_prompts.
--
-- The original migration (20260411100000_sonnet_prompts.sql) created a SELECT
-- policy USING (true) for the `authenticated` role, so any authenticated user
-- could read every workspace's prompt rules — a cross-tenant read as soon as
-- merchant-specific rules started being seeded (see the amazing-coffee-supply
-- tier-pricing spec merge, sha 2b01bf1ab80203c26e25395d2c87c8c1c95153a0).
--
-- This migration replaces that policy with a workspace_members-based check so
-- an authenticated user only sees rows for workspaces they belong to. The
-- existing service_role policy is preserved (idempotent DROP/CREATE) — the
-- orchestrator and cx-agent SDK read via createAdminClient() and remain
-- unaffected.

DROP POLICY IF EXISTS "Workspace members can read sonnet_prompts" ON public.sonnet_prompts;
DROP POLICY IF EXISTS "Service role full access on sonnet_prompts" ON public.sonnet_prompts;

CREATE POLICY "sonnet_prompts_select_own_workspace" ON public.sonnet_prompts
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "sonnet_prompts_service_role_all" ON public.sonnet_prompts
  FOR ALL
  USING (auth.jwt()->>'role' = 'service_role')
  WITH CHECK (auth.jwt()->>'role' = 'service_role');
