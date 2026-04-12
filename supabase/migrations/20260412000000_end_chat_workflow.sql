-- Add end_chat to template check constraint
ALTER TABLE workflows DROP CONSTRAINT IF EXISTS workflows_template_check;
ALTER TABLE workflows ADD CONSTRAINT workflows_template_check
  CHECK (template IN ('order_tracking', 'cancel_request', 'subscription_inquiry', 'account_login', 'end_chat'));

-- End Chat workflow — agent can trigger to gracefully end a live chat session
INSERT INTO workflows (workspace_id, name, template, trigger_tag, enabled, config)
SELECT w.id, 'End Chat', 'end_chat', 'end_chat', true, '{}'::jsonb
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM workflows wf WHERE wf.workspace_id = w.id AND wf.template = 'end_chat'
);
