-- Crisis journey definitions for the 3 tiers
INSERT INTO journey_definitions (workspace_id, slug, name, journey_type, trigger_intent, description, config, channels, is_active, priority)
SELECT
  'fdc11e10-b89f-4989-8b73-ed6526c4d906',
  'crisis-tier1-flavor-swap',
  'Crisis Tier 1 — Flavor Swap',
  'custom',
  'crisis_tier1',
  'Offer alternative flavor when affected item is out of stock',
  '{}',
  ARRAY['email'],
  true,
  10
WHERE NOT EXISTS (
  SELECT 1 FROM journey_definitions
  WHERE workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
  AND slug = 'crisis-tier1-flavor-swap'
);

INSERT INTO journey_definitions (workspace_id, slug, name, journey_type, trigger_intent, description, config, channels, is_active, priority)
SELECT
  'fdc11e10-b89f-4989-8b73-ed6526c4d906',
  'crisis-tier2-product-swap',
  'Crisis Tier 2 — Product Swap',
  'custom',
  'crisis_tier2',
  'Offer alternative product with coupon when flavor swap rejected',
  '{}',
  ARRAY['email'],
  true,
  10
WHERE NOT EXISTS (
  SELECT 1 FROM journey_definitions
  WHERE workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
  AND slug = 'crisis-tier2-product-swap'
);

INSERT INTO journey_definitions (workspace_id, slug, name, journey_type, trigger_intent, description, config, channels, is_active, priority)
SELECT
  'fdc11e10-b89f-4989-8b73-ed6526c4d906',
  'crisis-tier3-pause-remove',
  'Crisis Tier 3 — Pause/Remove',
  'custom',
  'crisis_tier3',
  'Offer to pause subscription or remove item when product swap rejected',
  '{}',
  ARRAY['email'],
  true,
  10
WHERE NOT EXISTS (
  SELECT 1 FROM journey_definitions
  WHERE workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
  AND slug = 'crisis-tier3-pause-remove'
);
