-- Strengthen cancel rule — Sonnet was bypassing it with ai_response

UPDATE sonnet_prompts
SET content = 'For ANY cancel request (cancel subscription, cancel account, cancel order, stop deliveries, etc.) → you MUST route to the cancel_subscription journey. NEVER respond with "your subscription has been cancelled" or similar — you CANNOT cancel directly. The cancel journey has retention offers and policy checks that must run. Even if the customer is upset or says "just cancel it", route to the journey.'
WHERE title = 'Cancel requests';

-- Also prevent positive close from firing on agent farewell messages
INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Never fake confirmations', 'NEVER tell a customer that an action has been completed unless you actually executed it via a direct_action and got "Action completed" confirmation. Saying "your subscription has been cancelled" without actually cancelling it is lying to the customer.', 26
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Never fake confirmations');
