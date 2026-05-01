-- Seed the "Amazon Reseller Address" fraud rule for every workspace
-- that has fraud rules enabled. Default to is_active=false so admins
-- explicitly opt in after they've reviewed the discovered resellers
-- (the discovery cron creates rows with status='unverified').
INSERT INTO fraud_rules (workspace_id, name, rule_type, description, config, severity, is_active, is_seeded)
SELECT w.id, 'Amazon Reseller Address Match', 'amazon_reseller',
  'Flag orders whose shipping or billing address matches a known Amazon reseller (from known_resellers). Uses fast normalized-string match plus Haiku fuzzy match for deliberately obfuscated variants.',
  '{"haiku_fallback": true}'::jsonb, 'high', false, true
FROM workspaces w
WHERE EXISTS (SELECT 1 FROM fraud_rules fr WHERE fr.workspace_id = w.id)
ON CONFLICT DO NOTHING;
