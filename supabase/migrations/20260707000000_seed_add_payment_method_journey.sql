-- Seed the add_payment_method journey definition for every workspace.
-- Code-driven journey (config='{}'); src/lib/add-payment-method-journey-builder.ts
-- generates the single card-entry step at click time via journey-step-builder.

INSERT INTO journey_definitions (workspace_id, slug, name, journey_type, trigger_intent, description, config, channels, is_active, priority)
SELECT
  w.id,
  'add-payment-method',
  'Add a Payment Method',
  'custom',
  'add_payment_method',
  'Customer with no vaulted payment method adds one in-flow — vaults in Braintree and (Phase 2) migrates any Appstle subs to internal billing.',
  '{}',
  ARRAY['email', 'chat', 'sms', 'portal'],
  true,
  50
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM journey_definitions jd
  WHERE jd.workspace_id = w.id AND jd.slug = 'add-payment-method'
);
