-- Email inbound filters — block spam/system emails from creating tickets
-- DB-driven so filters can be managed without deploys

CREATE TABLE public.email_filters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  filter_type TEXT NOT NULL CHECK (filter_type IN ('domain', 'sender', 'subject')),
  pattern TEXT NOT NULL, -- exact match for domain/sender, contains match for subject
  action TEXT NOT NULL DEFAULT 'block' CHECK (action IN ('block', 'allow')),
  reason TEXT, -- why this filter exists
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_filters_ws ON email_filters(workspace_id, is_active, filter_type);

ALTER TABLE public.email_filters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth read email_filters" ON public.email_filters FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full email_filters" ON public.email_filters FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON email_filters TO service_role;
GRANT SELECT ON email_filters TO authenticated;

-- Seed default filters
INSERT INTO public.email_filters (workspace_id, filter_type, pattern, action, reason) VALUES
-- Get workspace ID dynamically
((SELECT id FROM workspaces LIMIT 1), 'domain', 'paypal.com', 'block', 'PayPal billing agreement notifications'),
((SELECT id FROM workspaces LIMIT 1), 'domain', 'google.com', 'block', 'Google security alerts'),
((SELECT id FROM workspaces LIMIT 1), 'domain', 'facebookmail.com', 'block', 'Facebook notifications'),
((SELECT id FROM workspaces LIMIT 1), 'domain', 'facebook.com', 'block', 'Facebook notifications'),
((SELECT id FROM workspaces LIMIT 1), 'domain', 'walmart.com', 'block', 'Walmart marketplace emails'),
((SELECT id FROM workspaces LIMIT 1), 'domain', 'shopify.com', 'block', 'Shopify system emails'),
((SELECT id FROM workspaces LIMIT 1), 'domain', 'braintreegateway.com', 'block', 'Braintree payment notifications'),
((SELECT id FROM workspaces LIMIT 1), 'sender', 'noreply@', 'block', 'No-reply system emails'),
((SELECT id FROM workspaces LIMIT 1), 'sender', 'no-reply@', 'block', 'No-reply system emails'),
((SELECT id FROM workspaces LIMIT 1), 'sender', 'mailer-daemon@', 'block', 'Bounce notifications'),
((SELECT id FROM workspaces LIMIT 1), 'sender', 'notifications@', 'block', 'System notifications'),
((SELECT id FROM workspaces LIMIT 1), 'subject', 'billing agreement', 'block', 'PayPal/Braintree billing agreement changes'),
((SELECT id FROM workspaces LIMIT 1), 'subject', 'security alert', 'block', 'Security alert notifications'),
((SELECT id FROM workspaces LIMIT 1), 'subject', 'has been delivered', 'block', 'Shipment delivery notifications'),
((SELECT id FROM workspaces LIMIT 1), 'subject', 'webinar', 'block', 'Marketing webinar invites');
