-- Add new step types to the check constraint
ALTER TABLE playbook_steps DROP CONSTRAINT IF EXISTS playbook_steps_type_check;
ALTER TABLE playbook_steps ADD CONSTRAINT playbook_steps_type_check CHECK (
  type IN (
    'identify_order', 'identify_subscription', 'check_other_subscriptions',
    'apply_policy', 'offer_exception', 'initiate_return', 'cancel_subscription',
    'issue_store_credit', 'stand_firm', 'explain', 'custom',
    'check_tracking', 'classify_issue', 'select_missing_items',
    'confirm_shipping_address', 'create_replacement', 'adjust_subscription'
  )
);

-- Seed shipping address and missing items journey definitions
-- These are code-driven journeys (empty config, step-builder handles steps)

INSERT INTO journey_definitions (workspace_id, slug, name, journey_type, trigger_intent, description, config, channels, is_active, priority)
SELECT
  'fdc11e10-b89f-4989-8b73-ed6526c4d906',
  'shipping-address',
  'Confirm Shipping Address',
  'address_change',
  'shipping_address',
  'Confirms or updates customer shipping address with EasyPost validation',
  '{}',
  ARRAY['email', 'chat', 'sms'],
  true,
  50
WHERE NOT EXISTS (
  SELECT 1 FROM journey_definitions
  WHERE workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
  AND trigger_intent = 'shipping_address'
);

INSERT INTO journey_definitions (workspace_id, slug, name, journey_type, trigger_intent, description, config, channels, is_active, priority)
SELECT
  'fdc11e10-b89f-4989-8b73-ed6526c4d906',
  'missing-items',
  'Missing Items Checklist',
  'custom',
  'missing_items',
  'Customer selects which order items were missing or damaged for replacement',
  '{}',
  ARRAY['email', 'chat', 'sms'],
  true,
  50
WHERE NOT EXISTS (
  SELECT 1 FROM journey_definitions
  WHERE workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
  AND trigger_intent = 'missing_items'
);

-- Seed the replacement order playbook with steps
INSERT INTO playbooks (workspace_id, name, description, is_active, priority, exception_limit, stand_firm_max, stand_firm_before_exceptions, stand_firm_between_tiers, exception_disqualifiers, disqualifier_behavior)
SELECT
  'fdc11e10-b89f-4989-8b73-ed6526c4d906',
  'Replacement Order',
  'Handles order replacements for delivery errors, missing/damaged items, and wrong addresses',
  true,
  50,
  0, 0, 0, 0,
  '[]'::jsonb,
  'block_exceptions'
WHERE NOT EXISTS (
  SELECT 1 FROM playbooks
  WHERE workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
  AND name = 'Replacement Order'
);

-- Insert playbook steps
INSERT INTO playbook_steps (workspace_id, playbook_id, type, step_order, name, config)
SELECT p.workspace_id, p.id, 'identify_order', 0, 'Identify Order', '{"lookback_days": 30}'::jsonb
FROM playbooks p WHERE p.name = 'Replacement Order' AND p.workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
AND NOT EXISTS (SELECT 1 FROM playbook_steps WHERE playbook_id = p.id);

INSERT INTO playbook_steps (workspace_id, playbook_id, type, step_order, name, config)
SELECT p.workspace_id, p.id, 'check_tracking', 1, 'Check Tracking', '{}'::jsonb
FROM playbooks p WHERE p.name = 'Replacement Order' AND p.workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
AND NOT EXISTS (SELECT 1 FROM playbook_steps WHERE playbook_id = p.id AND type = 'check_tracking');

INSERT INTO playbook_steps (workspace_id, playbook_id, type, step_order, name, config)
SELECT p.workspace_id, p.id, 'classify_issue', 2, 'Classify Issue', '{}'::jsonb
FROM playbooks p WHERE p.name = 'Replacement Order' AND p.workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
AND NOT EXISTS (SELECT 1 FROM playbook_steps WHERE playbook_id = p.id AND type = 'classify_issue');

INSERT INTO playbook_steps (workspace_id, playbook_id, type, step_order, name, config)
SELECT p.workspace_id, p.id, 'select_missing_items', 3, 'Select Missing Items', '{}'::jsonb
FROM playbooks p WHERE p.name = 'Replacement Order' AND p.workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
AND NOT EXISTS (SELECT 1 FROM playbook_steps WHERE playbook_id = p.id AND type = 'select_missing_items');

INSERT INTO playbook_steps (workspace_id, playbook_id, type, step_order, name, config)
SELECT p.workspace_id, p.id, 'confirm_shipping_address', 4, 'Confirm Shipping Address', '{}'::jsonb
FROM playbooks p WHERE p.name = 'Replacement Order' AND p.workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
AND NOT EXISTS (SELECT 1 FROM playbook_steps WHERE playbook_id = p.id AND type = 'confirm_shipping_address');

INSERT INTO playbook_steps (workspace_id, playbook_id, type, step_order, name, config)
SELECT p.workspace_id, p.id, 'create_replacement', 5, 'Create Replacement Order', '{}'::jsonb
FROM playbooks p WHERE p.name = 'Replacement Order' AND p.workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
AND NOT EXISTS (SELECT 1 FROM playbook_steps WHERE playbook_id = p.id AND type = 'create_replacement');

INSERT INTO playbook_steps (workspace_id, playbook_id, type, step_order, name, config)
SELECT p.workspace_id, p.id, 'adjust_subscription', 6, 'Adjust Subscription', '{}'::jsonb
FROM playbooks p WHERE p.name = 'Replacement Order' AND p.workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
AND NOT EXISTS (SELECT 1 FROM playbook_steps WHERE playbook_id = p.id AND type = 'adjust_subscription');
