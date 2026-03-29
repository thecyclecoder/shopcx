-- Fraud order hold: tag suspicious orders in Shopify + new detection rules

-- Track which fraud cases have orders held
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS orders_held BOOLEAN DEFAULT false;

-- Seed new fraud rules for all workspaces that have fraud rules enabled
-- address_distance: billing/shipping zip > threshold miles apart
INSERT INTO fraud_rules (workspace_id, name, rule_type, description, config, severity, is_active, is_seeded)
SELECT w.id, 'Billing/Shipping Distance', 'address_distance',
  'Flag orders where billing and shipping zip codes are far apart',
  '{"distance_threshold_miles": 100}'::jsonb, 'medium', false, true
FROM workspaces w
WHERE EXISTS (SELECT 1 FROM fraud_rules fr WHERE fr.workspace_id = w.id)
ON CONFLICT DO NOTHING;

-- name_mismatch: billing name != customer name
INSERT INTO fraud_rules (workspace_id, name, rule_type, description, config, severity, is_active, is_seeded)
SELECT w.id, 'Billing Name Mismatch', 'name_mismatch',
  'Flag orders where billing name does not match the customer name',
  '{"ignore_last_name_match": true}'::jsonb, 'low', false, true
FROM workspaces w
WHERE EXISTS (SELECT 1 FROM fraud_rules fr WHERE fr.workspace_id = w.id)
ON CONFLICT DO NOTHING;
