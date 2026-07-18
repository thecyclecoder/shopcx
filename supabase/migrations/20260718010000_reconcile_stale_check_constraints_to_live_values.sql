-- Drift reconciliation (2026-07-18). Three merged CHECK-swap migrations parked forever as
-- merged-but-unapplied because their new CHECK sets OMITTED values already present in live prod data,
-- so ADD CONSTRAINT failed validation ("… is violated by some row"):
--   • 20260610210000_promo_graphics            — source_kind set omitted 'blog' (76 live rows)
--   • 20260705160000_dashboard_notifications…  — type set omitted 'mario_accuracy_alarm' (live rows)
--   • 20260910120000_god_mode_active_plan      — risk set omitted 'decision' (10 live rows)
-- This migration re-adds each CHECK as the UNION of (each original migration's intended set) + (the
-- live in-use values it forgot), so the constraint the authors wanted is finally in force AND no
-- existing row is rejected. The three originals are recorded as superseded in the same reconcile pass
-- (their intent is subsumed here). Idempotent (DROP IF EXISTS + ADD).

-- scheduled_social_posts.source_kind — intended (avatar, ad_video, testimonial, resource, promo) + live 'blog'.
ALTER TABLE public.scheduled_social_posts DROP CONSTRAINT IF EXISTS scheduled_social_posts_source_kind_check;
ALTER TABLE public.scheduled_social_posts ADD CONSTRAINT scheduled_social_posts_source_kind_check
  CHECK (source_kind IN ('avatar', 'ad_video', 'testimonial', 'resource', 'promo', 'blog'));

-- dashboard_notifications.type — intended agent-type set + live 'mario_accuracy_alarm'.
ALTER TABLE public.dashboard_notifications DROP CONSTRAINT IF EXISTS dashboard_notifications_type_check;
ALTER TABLE public.dashboard_notifications ADD CONSTRAINT dashboard_notifications_type_check
  CHECK (type = ANY (ARRAY[
    'macro_suggestion', 'pattern_review', 'knowledge_gap', 'system', 'fraud_alert',
    'chargeback_alert', 'duplicate_order_alert', 'escalation_gap',
    'agent_approval_request', 'agent_message', 'agent_daily_summary',
    'mario_accuracy_alarm'
  ]));

-- god_mode_approvals.risk — intended (safe, write, destructive, plan) + live legacy 'decision'.
ALTER TABLE public.god_mode_approvals DROP CONSTRAINT IF EXISTS god_mode_approvals_risk_check;
ALTER TABLE public.god_mode_approvals ADD CONSTRAINT god_mode_approvals_risk_check
  CHECK (risk = ANY (ARRAY['safe'::text, 'write'::text, 'destructive'::text, 'plan'::text, 'decision'::text]));
