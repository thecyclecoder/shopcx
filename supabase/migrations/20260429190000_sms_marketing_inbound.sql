-- Inbound replies to the marketing shortcode (85041). Used by the
-- autoresponder webhook for 24h dedupe + so the team can see what
-- people are saying. Not tied to tickets — these are not support
-- conversations, they're stray replies to marketing blasts.

CREATE TABLE IF NOT EXISTS public.sms_marketing_inbound (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE,
  shortcode TEXT NOT NULL,
  from_phone TEXT NOT NULL,
  body TEXT,
  message_sid TEXT UNIQUE,
  autoresponded BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedupe lookup: "did this number already get an autoresponse in the last 24h on this shortcode?"
CREATE INDEX idx_sms_marketing_inbound_phone_recent
  ON public.sms_marketing_inbound(shortcode, from_phone, created_at DESC);

ALTER TABLE public.sms_marketing_inbound ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on sms_marketing_inbound" ON public.sms_marketing_inbound
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Workspace members can read sms_marketing_inbound" ON public.sms_marketing_inbound
  FOR SELECT TO authenticated USING (
    workspace_id IS NULL OR workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
    )
  );
