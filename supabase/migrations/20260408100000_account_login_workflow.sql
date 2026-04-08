-- Add account_login to the template check constraint
ALTER TABLE workflows DROP CONSTRAINT IF EXISTS workflows_template_check;
ALTER TABLE workflows ADD CONSTRAINT workflows_template_check CHECK (
  template IN ('order_tracking', 'cancel_request', 'subscription_inquiry', 'account_login')
);

-- Account Login workflow — sends magic link when customer asks about login/access
INSERT INTO workflows (workspace_id, name, template, trigger_tag, enabled, config)
SELECT
  'fdc11e10-b89f-4989-8b73-ed6526c4d906',
  'Account Login',
  'account_login',
  'smart:account_login',
  true,
  '{}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM workflows
  WHERE workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
  AND template = 'account_login'
);

-- Smart pattern for account login detection
INSERT INTO smart_patterns (workspace_id, name, category, phrases, auto_tag, active)
SELECT
  'fdc11e10-b89f-4989-8b73-ed6526c4d906',
  'Account login and access',
  'account_login',
  '["can''t sign in","can''t log in","cannot login","can''t login","unable to login","unable to sign in","how do I login","how do I log in","how do I sign in","how to login","how to access my account","how do I access my account","where do I log in","where do I sign in","forgot my password","reset my password","password reset","can''t access my account","trouble logging in","trouble signing in","login help","sign in help","account access"]'::jsonb,
  'smart:account_login',
  true
WHERE NOT EXISTS (
  SELECT 1 FROM smart_patterns
  WHERE workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
  AND category = 'account_login'
);
