-- Seed new AI workflows for return, address change, subscription modification, and order status
-- These use workspace_id from the first workspace; adjust for multi-tenant seeding

INSERT INTO ai_workflows (workspace_id, name, description, enabled, trigger_intent, match_patterns, match_categories, response_source, allowed_actions, config)
SELECT w.id,
  'Return Request',
  'Handle return and exchange requests',
  true,
  'return_request',
  ARRAY['return', 'exchange', 'wrong item', 'damaged', 'broken', 'not what I ordered', 'send back', 'refund', 'send it back'],
  ARRAY['policy'],
  'either',
  '["create_return"]',
  '{}'::jsonb
FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM ai_workflows WHERE workspace_id = w.id AND trigger_intent = 'return_request');

INSERT INTO ai_workflows (workspace_id, name, description, enabled, trigger_intent, match_patterns, match_categories, response_source, allowed_actions, config)
SELECT w.id,
  'Address Change',
  'Update shipping address on orders or subscriptions',
  true,
  'address_change',
  ARRAY['change address', 'update address', 'wrong address', 'moved', 'new address', 'shipping address', 'change my address'],
  ARRAY['shipping'],
  'either',
  '["update_address"]',
  '{}'::jsonb
FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM ai_workflows WHERE workspace_id = w.id AND trigger_intent = 'address_change');

INSERT INTO ai_workflows (workspace_id, name, description, enabled, trigger_intent, match_patterns, match_categories, response_source, allowed_actions, config)
SELECT w.id,
  'Subscription Change',
  'Skip, swap, or change subscription frequency',
  true,
  'subscription_change',
  ARRAY['skip', 'swap', 'change frequency', 'every 2 weeks', 'every month', 'pause', 'hold', 'skip next', 'change product', 'switch flavor'],
  ARRAY['subscription'],
  'either',
  '["modify_subscription"]',
  '{}'::jsonb
FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM ai_workflows WHERE workspace_id = w.id AND trigger_intent = 'subscription_change');

INSERT INTO ai_workflows (workspace_id, name, description, enabled, trigger_intent, match_patterns, match_categories, response_source, allowed_actions, config)
SELECT w.id,
  'Order Status',
  'Provide order tracking and delivery status information',
  true,
  'order_status',
  ARRAY['where is my order', 'tracking', 'delivery', 'shipped', 'when will I get', 'order status', 'package', 'shipment'],
  ARRAY['shipping'],
  'either',
  '[]',
  '{}'::jsonb
FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM ai_workflows WHERE workspace_id = w.id AND trigger_intent = 'order_status');
