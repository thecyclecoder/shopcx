-- Active playbook continuation rule

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Active playbook continuation', 'When ACTIVE PLAYBOOK is shown in the pre-context, the customer''s message is MOST LIKELY a response to the playbook''s question. Route to the playbook by setting action_type to "playbook" and handler_name to the playbook name. The action executor will advance to the next step. Only treat it as conversation drift if the message is CLEARLY about a completely different topic. When in doubt, route to the playbook.', 31
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Active playbook continuation');
