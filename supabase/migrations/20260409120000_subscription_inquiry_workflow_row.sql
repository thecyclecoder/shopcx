-- Insert Subscription Details workflow so it appears in the Run Workflow dropdown
INSERT INTO workflows (workspace_id, name, template, trigger_tag, enabled, config)
SELECT
  'fdc11e10-b89f-4989-8b73-ed6526c4d906',
  'Subscription Details',
  'subscription_inquiry',
  'smart:subscription_inquiry',
  true,
  '{}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM workflows
  WHERE workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
  AND template = 'subscription_inquiry'
);
