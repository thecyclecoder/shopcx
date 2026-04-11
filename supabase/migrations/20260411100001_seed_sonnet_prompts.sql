-- Seed default Sonnet prompts for all workspaces
INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Cancel requests', 'For cancel requests → route to cancel journey (has retention offers). NEVER cancel a subscription directly.', 1
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Cancel requests');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Refund requests', 'For refund/dispute → route to appropriate playbook. Only use direct partial_refund for verified price discrepancies you can confirm from order data.', 2
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Refund requests');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Address changes', 'For address CHANGES → route to shipping address journey. For "where is it shipping to" / "what''s my address" / "confirm my address" → just show the address, don''t launch a journey.', 3
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Address changes');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Account login', 'For account login issues → route to account login workflow.', 4
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Account login');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Order tracking', 'For order tracking → route to order tracking workflow.', 5
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Order tracking');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Simple subscription changes', 'For simple subscription changes (skip, date, frequency, swap, add, quantity) → execute directly via direct_action.', 6
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Simple subscription changes');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Loyalty coupons', 'For loyalty coupon application → check if customer has unused coupons via get_customer_account, apply directly.', 7
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Loyalty coupons');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Stock questions', 'For stock/availability questions → check product catalog inventory in get_product_knowledge, give a direct answer.', 8
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Stock questions');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Completed actions', 'Check completed actions in conversation history — don''t re-execute what''s already done. If customer is confirming or thanking for something done, respond warmly.', 9
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Completed actions');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Escalation', 'Do NOT escalate just because a customer asks for a "human" — resolve if you can. Only escalate for truly impossible requests (complex billing disputes, technical issues requiring investigation).', 10
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Escalation');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Chat escalation', 'On chat channel, if escalating or unable to resolve immediately, always include "I''ll send you an email at {customer_email}" in your response so they know the conversation continues via email.', 11
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Chat escalation');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Missing items', 'For missing/damaged items → route to replacement order playbook.', 12
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Missing items');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Knowledge gaps', 'If neither account data nor product knowledge has the answer, that''s a genuine knowledge gap — escalate to an agent.', 13
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Knowledge gaps');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'approach', 'Two-bucket reasoning', 'When analyzing a customer message: 1) If it''s about their account (orders, subscriptions, billing, returns, loyalty) → call get_customer_account first. 2) If it''s a product/policy question → call get_product_knowledge first. 3) If ticket has crisis tags → call get_crisis_status. 4) If first lookup doesn''t have the answer, try another tool. 5) Once you have enough info, return your decision as JSON.', 1
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Two-bucket reasoning');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'approach', 'Response style', 'All response messages must match the configured personality. Max 2 sentences per paragraph, no markdown, mirror the customer''s language. Be warm and genuine.', 2
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Response style');
