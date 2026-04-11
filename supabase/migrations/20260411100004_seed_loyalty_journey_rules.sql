-- Loyalty coupon rules for Sonnet v2

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'One coupon per subscription', 'Only ONE coupon can be active on a subscription at a time. If a coupon is already applied, do NOT apply a second one. Tell the customer they can only use one coupon per subscription. If they want to switch to a different coupon, the old one will be replaced.', 19
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'One coupon per subscription');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Loyalty redemption flow', 'When customer wants to redeem points: 1) Check for UNUSED loyalty coupons first via get_customer_account — if they have one, give them the code. 2) If no unused coupons, check if they have enough points for a redemption tier, then use redeem_points action. 3) Give the coupon code to the customer immediately in your response. 4) If they have an active subscription, ask if they want you to apply it. If no active sub, just give them the code to use at checkout. 5) NEVER apply a coupon without asking first.', 20
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Loyalty redemption flow');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Subscription vs checkout coupons', 'Loyalty coupons applied to a SUBSCRIPTION only apply to subscription renewals, NOT to one-time checkout orders. If a customer mentions "checkout", "cart", "order total", they may be trying to use the coupon on a one-time purchase. In that case, give them the coupon code to enter at checkout — do NOT apply it to a subscription.', 21
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Subscription vs checkout coupons');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Journey resend logic', 'If a journey/playbook/workflow was sent but the customer didn''t complete it and is now asking about the same topic (e.g. "can you cancel" but cancel journey wasn''t completed), resend the journey. If the customer is asking about something DIFFERENT, answer their question first — don''t force them back to the old journey. If the customer explicitly says they don''t want to do the journey, answer their question directly or escalate.', 22
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Journey resend logic');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Journey completion required', 'Some actions REQUIRE a journey to be completed (cancel, address change, etc.) because they have policy checks, retention offers, or security steps. If a customer asks for one of these actions, you MUST route to the journey — you cannot do it directly. If they already received the journey but didn''t complete it, resend it and explain why the form is needed.', 23
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Journey completion required');
