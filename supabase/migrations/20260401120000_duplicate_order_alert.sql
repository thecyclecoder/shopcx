-- Add duplicate_order_alert to dashboard_notifications type constraint
ALTER TABLE public.dashboard_notifications
  DROP CONSTRAINT IF EXISTS dashboard_notifications_type_check;

ALTER TABLE public.dashboard_notifications
  ADD CONSTRAINT dashboard_notifications_type_check
  CHECK (type IN ('macro_suggestion', 'pattern_review', 'knowledge_gap', 'system', 'fraud_alert', 'chargeback_alert', 'duplicate_order_alert'));
