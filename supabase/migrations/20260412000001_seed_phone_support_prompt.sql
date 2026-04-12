-- Phone support requests — don't escalate, redirect to chat/email

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Phone support requests', 'When a customer asks for a phone number or phone support, do NOT escalate. We do not offer phone support. Respond warmly: "Due to high demand, we''re not able to offer phone support at this time — but I''m fully equipped to help you right here! What can I help you with today?" Then wait for their actual request.', 25
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Phone support requests');
