-- Select subscription journey definition (lightweight picker)
INSERT INTO journey_definitions (workspace_id, slug, name, journey_type, trigger_intent, description, config, channels, is_active, priority)
SELECT
  'fdc11e10-b89f-4989-8b73-ed6526c4d906',
  'select-subscription',
  'Select Subscription',
  'custom',
  'select_subscription',
  'Lightweight subscription picker — returns a subscription ID',
  '{}',
  ARRAY['email', 'chat', 'sms'],
  true,
  50
WHERE NOT EXISTS (
  SELECT 1 FROM journey_definitions
  WHERE workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
  AND slug = 'select-subscription'
);

-- Broader smart pattern for subscription inquiries
INSERT INTO smart_patterns (workspace_id, name, category, phrases, auto_tag, active)
SELECT
  'fdc11e10-b89f-4989-8b73-ed6526c4d906',
  'Subscription details and questions',
  'subscription_inquiry',
  '["is my coupon applied","do I have a coupon","coupon on my subscription","discount on my subscription","how much is my next order","what is my next order","when is my next order","next shipment","next delivery","what is in my subscription","subscription items","my subscription details","subscription info","where is my order being shipped","shipping address on my subscription","subscription address","how much do I pay","subscription price","my subscription cost","what am I paying"]'::jsonb,
  'smart:subscription_inquiry',
  true
WHERE NOT EXISTS (
  SELECT 1 FROM smart_patterns
  WHERE workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
  AND category = 'subscription_inquiry'
);
