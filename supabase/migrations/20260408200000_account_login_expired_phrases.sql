-- Add "link expired" phrases to account_login smart pattern so customers
-- who report an expired magic link automatically get a fresh one
UPDATE smart_patterns
SET phrases = phrases || '["link expired","link is expired","my link expired","expired link","link doesn''t work","link no longer works","link not working","link isn''t working","the link doesn''t work","send me a new link","send another link","new login link","login link expired","magic link expired"]'::jsonb
WHERE category = 'account_login'
  AND workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906';
