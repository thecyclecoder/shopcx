-- Seed default playbooks for workspace fdc11e10-b89f-4989-8b73-ed6526c4d906
-- Idempotent: skips if playbooks already exist

DO $$
DECLARE
  ws_id UUID := 'fdc11e10-b89f-4989-8b73-ed6526c4d906';
  existing_count INTEGER;
  pb1_id UUID := gen_random_uuid();
  pb2_id UUID := gen_random_uuid();
  pol1_id UUID := gen_random_uuid();
  pol2_id UUID := gen_random_uuid();
BEGIN

SELECT COUNT(*) INTO existing_count FROM public.playbooks WHERE workspace_id = ws_id;
IF existing_count > 0 THEN
  RAISE NOTICE 'Playbooks already exist for this workspace, skipping seed';
  RETURN;
END IF;

-- ══ Playbook 1: Unwanted Charge / Subscription Dispute ══
INSERT INTO public.playbooks (id, workspace_id, name, description, trigger_intents, trigger_patterns, priority, is_active, exception_limit, stand_firm_max)
VALUES (pb1_id, ws_id,
  'Unwanted Charge / Subscription Dispute',
  'Handles customers who were charged for a subscription renewal they didn''t expect or want.',
  ARRAY['unwanted_charge', 'subscription_dispute', 'charged_without_permission', 'refund_request', 'unauthorized_charge'],
  ARRAY['charged without permission', 'didn''t sign up for subscription', 'unauthorized charge', 'charged me again', 'stop charging me', 'didn''t order this', 'cancel and refund', 'want my money back'],
  100, true, 1, 3
);

-- Policy: 30-Day Return
INSERT INTO public.playbook_policies (id, workspace_id, playbook_id, name, description, conditions, ai_talking_points, sort_order)
VALUES (pol1_id, ws_id, pb1_id,
  '30-Day Return Policy',
  'Products can be returned within 30 days of the order date for a refund or store credit. Customer must ship the product back at their expense.',
  '{"days_since_fulfillment": {"<=": 30}}',
  'Explain neutrally: "Your subscription was created on [date], and this was the automatic renewal." Never say "you signed up for this." Say "here''s what happened." Frame the return policy as a helpful option, not a punishment.',
  0
);

-- Exception: Tier 1 — Store Credit Return
INSERT INTO public.playbook_exceptions (workspace_id, playbook_id, policy_id, tier, name, conditions, resolution_type, instructions, auto_grant, sort_order)
VALUES (ws_id, pb1_id, pol1_id, 1,
  'Return for Store Credit',
  '{"or": [{"ltv_cents": {">=": 30000}}, {"total_orders": {">=": 3}}]}',
  'store_credit_return',
  'Lead with this option. Frame store credit as a benefit — "Your credit never expires and can be used on any product." The customer ships the product back at their expense. Once received, store credit is issued.',
  false, 0
);

-- Exception: Tier 2 — Refund Return
INSERT INTO public.playbook_exceptions (workspace_id, playbook_id, policy_id, tier, name, conditions, resolution_type, instructions, auto_grant, sort_order)
VALUES (ws_id, pb1_id, pol1_id, 2,
  'Return for Full Refund',
  '{"or": [{"ltv_cents": {">=": 30000}}, {"total_orders": {">=": 3}}]}',
  'refund_return',
  'Only offer this if customer rejected store credit. Same return process — they ship it back, refund is issued to original payment method once received.',
  false, 1
);

-- Auto-grant: Cancelled but charged (system error)
INSERT INTO public.playbook_exceptions (workspace_id, playbook_id, policy_id, tier, name, conditions, resolution_type, instructions, auto_grant, auto_grant_trigger, sort_order)
VALUES (ws_id, pb1_id, pol1_id, 0,
  'System Error — Refund Without Return',
  '{}',
  'refund_no_return',
  'Customer cancelled their subscription but was still charged due to a system error. Refund immediately, no return needed. Apologize sincerely.',
  true, 'cancelled_but_charged', 0
);

-- Steps
INSERT INTO public.playbook_steps (workspace_id, playbook_id, step_order, type, name, instructions, data_access, resolved_condition, config, skippable) VALUES
(ws_id, pb1_id, 0, 'identify_order',
  'Identify the order',
  'Find their recent orders. If only one, confirm it. If multiple, list them and ask which one(s). If they say "all of them," resolve to array. If they say "most recent" or "last order," use the most recent one.',
  ARRAY['recent_orders'], 'order_identified', '{"lookback_days": 90}', true),

(ws_id, pb1_id, 1, 'identify_subscription',
  'Identify the subscription',
  'Find the subscription that generated the identified order. Note when it was created and how many times it has renewed. This step is internal — don''t ask the customer, just look it up.',
  ARRAY['subscriptions'], 'subscription_identified', '{}', true),

(ws_id, pb1_id, 2, 'check_other_subscriptions',
  'Check for other active subscriptions',
  'Proactively check if the customer has other active subscriptions. If they do, mention them so the customer isn''t surprised by another charge later.',
  ARRAY['subscriptions'], 'other_subs_checked', '{}', true),

(ws_id, pb1_id, 3, 'apply_policy',
  'Explain the situation and policy',
  'Explain what happened with their subscription and order. Be neutral — "here''s what happened" not "you signed up." If the order is in policy, let them know a return is available. If not, move to the exception step. If they have other active subscriptions, mention them proactively.',
  ARRAY['recent_orders', 'subscriptions', 'customer_events'], 'policy_explained',
  format('{"policy_id": "%s"}', pol1_id)::jsonb, false),

(ws_id, pb1_id, 4, 'offer_exception',
  'Offer exception if eligible',
  'If the order is out of policy, check if the customer qualifies for an exception based on their LTV and order history. Offer store credit return first. If they reject, offer refund return. Apply exception to the most recent out-of-policy order only.',
  ARRAY['recent_orders'], 'exception_offered',
  format('{"policy_id": "%s"}', pol1_id)::jsonb, false),

(ws_id, pb1_id, 5, 'initiate_return',
  'Initiate the return',
  'Create the return in Shopify. Let the customer know they will receive return instructions via email. They need to ship the product back at their own expense. Once we receive it, their store credit or refund will be issued.',
  ARRAY['recent_orders'], 'return_initiated', '{"pre_check_eligibility": true}', false),

(ws_id, pb1_id, 6, 'cancel_subscription',
  'Cancel the subscription',
  'Cancel the subscription that generated the unwanted charge. Also offer to cancel any other active subscriptions if the customer wants. Confirm what was cancelled.',
  ARRAY['subscriptions'], 'subscription_cancelled', '{}', true),

(ws_id, pb1_id, 7, 'stand_firm',
  'Stand firm if all offers rejected',
  'If the customer rejects all offers, acknowledge their frustration but don''t budge beyond the defined exceptions. Never argue. Restate the best available offer in different words each time. After max repetitions, send a final message leaving the offer on the table.',
  ARRAY[]::text[], 'resolved', '{}', false);


-- ══ Playbook 2: Missing / Lost Order ══
INSERT INTO public.playbooks (id, workspace_id, name, description, trigger_intents, trigger_patterns, priority, is_active, exception_limit, stand_firm_max)
VALUES (pb2_id, ws_id,
  'Missing / Lost Order',
  'Handles customers whose order hasn''t arrived or shows as delivered but they didn''t receive it.',
  ARRAY['missing_order', 'order_not_received', 'lost_package', 'where_is_my_order'],
  ARRAY['never received', 'where is my order', 'package lost', 'tracking shows delivered but', 'hasn''t arrived', 'didn''t receive', 'missing package', 'order never came'],
  90, true, 1, 3
);

-- Policy: Delivery Policy
INSERT INTO public.playbook_policies (id, workspace_id, playbook_id, name, description, conditions, ai_talking_points, sort_order)
VALUES (pol2_id, ws_id, pb2_id,
  'Delivery Investigation Policy',
  'If tracking shows in transit, ask customer to wait. If tracking shows delivered, investigate with carrier. If truly lost, offer replacement or store credit.',
  '{}',
  'Be empathetic — a missing order is stressful. Lead with "let me look into this for you." Check tracking data before making any promises.',
  0
);

-- Steps
INSERT INTO public.playbook_steps (workspace_id, playbook_id, step_order, type, name, instructions, data_access, resolved_condition, config, skippable) VALUES
(ws_id, pb2_id, 0, 'identify_order',
  'Identify the order',
  'Find the order they''re asking about. Check recent orders and their fulfillment/delivery status.',
  ARRAY['recent_orders'], 'order_identified', '{"lookback_days": 60}', true),

(ws_id, pb2_id, 1, 'explain',
  'Share tracking status',
  'Look up the fulfillment and tracking data for the identified order. Share the current status with the customer. If in transit, give estimated delivery. If delivered, share delivery date and ask if someone else might have received it.',
  ARRAY['recent_orders'], 'tracking_shared', '{}', false),

(ws_id, pb2_id, 2, 'apply_policy',
  'Assess and resolve',
  'Based on the tracking status: if in transit, ask to wait. If delivered but customer says they didn''t get it, offer to file a carrier investigation or send a replacement. If truly lost (no tracking updates), offer replacement or store credit.',
  ARRAY['recent_orders'], 'resolution_offered',
  format('{"policy_id": "%s"}', pol2_id)::jsonb, false),

(ws_id, pb2_id, 3, 'stand_firm',
  'Handle pushback',
  'If customer is unsatisfied with the resolution offered, acknowledge frustration. For delivered-but-not-received, explain we need to work with the carrier. Don''t offer refunds on delivered packages without investigation.',
  ARRAY[]::text[], 'resolved', '{}', false);

END $$;
