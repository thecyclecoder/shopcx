-- Hotfix: eliminate two classes of PostgREST 400 that inflate the DB error-rate panel.
--
-- 1) dashboard_notifications type CHECK — code emits three notification types that were never
--    added to the constraint, so their fire-and-forget inserts were 23514-rejected (400) and the
--    notification silently lost: 'return_request' (src/lib/shopify-webhooks — return request),
--    'mario_accuracy_alarm' (src/lib/inngest/mario-stall-cron), 'refund_drift'
--    (src/lib/inngest/refund-settlement-reconcile). Additive: the new list is a superset.
--
-- 2) fraud_case_history → auth.users FK — the case-history read
--    (src/app/api/workspaces/[id]/fraud-cases/[caseId]/route.ts) embeds `users:user_id(email,...)`,
--    but with no FK PostgREST can't resolve the relationship and returns 400 (the embed matches
--    the working workspace_members_user_id_fkey → auth.users pattern). Verified clean: all 447
--    fraud_case_history rows have a user_id that exists in auth.users (0 orphaned), so the
--    constraint validates without a data fix.

alter table public.dashboard_notifications
  drop constraint if exists dashboard_notifications_type_check;

alter table public.dashboard_notifications
  add constraint dashboard_notifications_type_check check (
    type = any (array[
      'macro_suggestion','pattern_review','knowledge_gap','system','fraud_alert',
      'chargeback_alert','duplicate_order_alert','escalation_gap','agent_approval_request',
      'agent_message','agent_daily_summary','return_request','mario_accuracy_alarm','refund_drift'
    ]::text[])
  );

alter table public.fraud_case_history
  drop constraint if exists fraud_case_history_user_id_fkey;

alter table public.fraud_case_history
  add constraint fraud_case_history_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;
