-- Email open/click tracking via Resend webhooks
-- Universal table for all email types (ticket replies, crisis, CSAT, dunning, marketing)

CREATE TABLE IF NOT EXISTS public.email_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  resend_email_id TEXT NOT NULL,
  event_type TEXT NOT NULL,  -- sent, delivered, opened, clicked, bounced, complained
  occurred_at TIMESTAMPTZ NOT NULL,
  recipient_email TEXT,
  subject TEXT,
  metadata JSONB DEFAULT '{}',  -- click URL, bounce reason, etc.
  ticket_id UUID REFERENCES public.tickets(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_events_resend_id ON public.email_events(resend_email_id);
CREATE INDEX IF NOT EXISTS idx_email_events_workspace ON public.email_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_events_customer ON public.email_events(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_events_ticket ON public.email_events(ticket_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_events_dedup ON public.email_events(resend_email_id, event_type, occurred_at);

-- Add resend_email_id and email_status to ticket_messages
ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS resend_email_id TEXT;
ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS email_status TEXT;

-- Webhook signing secret for Resend tracking events
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS resend_webhook_signing_secret TEXT;

-- RLS
ALTER TABLE public.email_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "email_events_select" ON public.email_events FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

CREATE POLICY "email_events_service" ON public.email_events FOR ALL TO service_role USING (true);

-- Backfill: extract resend_email_id from existing email_message_id values
-- Format: <uuid@resend.dev> → uuid
UPDATE ticket_messages
SET resend_email_id = REPLACE(REPLACE(email_message_id, '<', ''), '@resend.dev>', '')
WHERE email_message_id IS NOT NULL
  AND email_message_id LIKE '<%@resend.dev>'
  AND resend_email_id IS NULL;
