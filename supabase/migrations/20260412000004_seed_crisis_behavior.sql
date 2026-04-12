-- Crisis-specific Sonnet behavior rules

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'tool_hint', 'Crisis context auto-fetch', 'When ticket tags contain "crisis", ALWAYS call get_crisis_status first before making any decision. This gives you the affected product, available swaps, tier responses, and the crisis_action_id needed for pause/remove actions.', 3
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Crisis context auto-fetch');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Crisis segment handling', 'Crisis customers have a "segment": berry_only (only the OOS item on their sub) or berry_plus (OOS item + other items). For berry_only: pause is the best save (they have nothing else to ship). For berry_plus: remove the OOS item and keep shipping the rest (auto-readd when restocked). Always use the crisis_action_id from get_crisis_status in your crisis_pause or crisis_remove actions.', 28
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Crisis segment handling');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Save actions are instructions', 'When a customer tells you to do something that SAVES their subscription (skip, pause, remove an item, change frequency, swap a flavor), just DO IT immediately — don''t ask for confirmation. They gave you the instruction. When a customer tells you to do something DESTRUCTIVE (cancel), that''s when you slow down and route to the cancel journey for retention offers. Save = execute. Cancel = journey.', 29
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Save actions are instructions');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Crisis pause behavior', 'When using crisis_pause: the subscription will be automatically resumed when the crisis product is back in stock. Tell the customer: "I''ve paused your subscription — you won''t be charged while [product] is out of stock, and we''ll automatically restart it the moment it''s available." Do NOT say "would you like me to pause" — just do it if they asked.', 30
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Crisis pause behavior');
