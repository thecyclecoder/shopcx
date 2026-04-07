-- Add clarify_issue to the check constraint
ALTER TABLE playbook_steps DROP CONSTRAINT IF EXISTS playbook_steps_type_check;
ALTER TABLE playbook_steps ADD CONSTRAINT playbook_steps_type_check CHECK (
  type IN (
    'identify_order', 'identify_subscription', 'check_other_subscriptions',
    'apply_policy', 'offer_exception', 'initiate_return', 'cancel_subscription',
    'issue_store_credit', 'stand_firm', 'explain', 'custom',
    'clarify_issue', 'check_tracking', 'classify_issue', 'select_missing_items',
    'confirm_shipping_address', 'create_replacement', 'adjust_subscription'
  )
);

-- Shift existing replacement playbook steps up by 1
UPDATE playbook_steps
SET step_order = step_order + 1
WHERE playbook_id = '0937d507-82ea-4d04-a4eb-c69b169255e3';

-- Insert clarify_issue at step 0
INSERT INTO playbook_steps (workspace_id, playbook_id, type, step_order, name, config)
SELECT
  'fdc11e10-b89f-4989-8b73-ed6526c4d906',
  '0937d507-82ea-4d04-a4eb-c69b169255e3',
  'clarify_issue',
  0,
  'Clarify Issue',
  '{}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM playbook_steps
  WHERE playbook_id = '0937d507-82ea-4d04-a4eb-c69b169255e3'
  AND type = 'clarify_issue'
);
