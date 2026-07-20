-- Storefront Optimizer policy — scope the SELECT RLS to workspace members.
--
-- optimizer-launch-hardening Phase 3, finding #5 (cross-workspace info-disclosure).
-- The original table migration (20260627120000_storefront_optimizer_policy.sql) shipped
-- a SELECT policy of `using (auth.uid() is not null)` despite its own "workspace-member
-- SELECT" comment — so ANY authenticated user could read EVERY workspace's optimizer
-- policy row (its active flag, product_scope, guardrails, rationale). Low impact (no
-- secrets; all writes go through the service role; product scope is re-enforced in code)
-- but a genuine cross-workspace read gap. This forward migration replaces that policy
-- with the canonical workspace-member scope used by public.products / workspace_members:
--   workspace_id ∈ (select workspace_id from workspace_members where user_id = auth.uid())
--
-- Migrations are immutable once applied, so we DROP + CREATE the SELECT policy here rather
-- than editing the original file (which already ran against prod). Idempotent: the
-- service-role write policy is untouched; the app reads policies via createAdminClient()
-- (service role), so this tightening does not affect the optimizer engine itself.
drop policy if exists storefront_optimizer_policy_select on public.storefront_optimizer_policy;
create policy storefront_optimizer_policy_select on public.storefront_optimizer_policy
  for select to authenticated using (
    workspace_id in (
      select workspace_id from public.workspace_members where user_id = auth.uid()
    )
  );
