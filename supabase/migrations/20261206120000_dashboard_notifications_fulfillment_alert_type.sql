-- amplifier-import-reliability-rail Phase 3 — add 'fulfillment_alert' to the
-- dashboard_notifications type CHECK. The reconcile sweep opens ONE deduped
-- 'fulfillment_alert' card per order whose amplifier_import_attempts reaches
-- the retry cap (5) still un-imported. Without this type on the CHECK the
-- fire-and-forget insert would 23514-reject (400) and the alarm silently
-- drop — the exact hotfix class 20260709120000 fixed for 'refund_drift' /
-- 'mario_accuracy_alarm' / 'return_request'. Additive; the new list is a
-- superset of the prior one.
ALTER TABLE public.dashboard_notifications
  DROP CONSTRAINT IF EXISTS dashboard_notifications_type_check;

ALTER TABLE public.dashboard_notifications
  ADD CONSTRAINT dashboard_notifications_type_check CHECK (
    type = ANY (ARRAY[
      'macro_suggestion','pattern_review','knowledge_gap','system','fraud_alert',
      'chargeback_alert','duplicate_order_alert','escalation_gap','agent_approval_request',
      'agent_message','agent_daily_summary','return_request','mario_accuracy_alarm','refund_drift',
      'fulfillment_alert'
    ]::text[])
  );
