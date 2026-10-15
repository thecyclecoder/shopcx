-- Add 'billing_alert' + 'box_account_auth_expired' to the dashboard_notifications type CHECK.
--
-- Production logged `new row for relation "dashboard_notifications" violates check constraint
-- "dashboard_notifications_type_check"` 6x between 2026-09-28 and 2026-10-14, each at the 09:00 UTC
-- internal-subscription-renewal cron. That cron's piggy-backed detectors —
-- src/lib/dunning-strand-detector.ts (stranded dunning cycles),
-- src/lib/subscription-duplicate-renewal-detector.ts (double-charged renewals) — and
-- src/lib/commerce/shopcx-renewal-price-check.ts all insert type='billing_alert', which no prior
-- version of this CHECK ever listed, so every billing alert was rejected (23514) and lost.
--
-- 'box_account_auth_expired' (scripts/builder-worker.ts emitCeoAuthExpiryAlertBestEffort — the
-- "box pool account needs a new login" bell card) had the same latent bug since 2026-07-25.
--
-- Additive + idempotent: the new list is a strict superset of 20261206120000's. Mirrored in
-- src/lib/dashboard-notification-types.ts (DASHBOARD_NOTIFICATION_TYPES); the unit test
-- src/lib/dashboard-notification-types.test.ts pins the two in lockstep.
ALTER TABLE public.dashboard_notifications
  DROP CONSTRAINT IF EXISTS dashboard_notifications_type_check;

ALTER TABLE public.dashboard_notifications
  ADD CONSTRAINT dashboard_notifications_type_check CHECK (
    type = ANY (ARRAY[
      'macro_suggestion','pattern_review','knowledge_gap','system','fraud_alert',
      'chargeback_alert','duplicate_order_alert','escalation_gap','agent_approval_request',
      'agent_message','agent_daily_summary','return_request','mario_accuracy_alarm','refund_drift',
      'fulfillment_alert','billing_alert','box_account_auth_expired'
    ]::text[])
  );
