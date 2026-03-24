-- Multiple support email addresses per workspace
CREATE TABLE public.support_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  label TEXT,  -- e.g. "Returns", "Orders", "General"
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, email)
);

CREATE INDEX idx_support_emails_workspace ON public.support_emails(workspace_id);

ALTER TABLE public.support_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view support emails in their workspaces"
  ON public.support_emails FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Service role full access on support_emails"
  ON public.support_emails FOR ALL
  USING (auth.role() = 'service_role');

-- Store the original To address on tickets for routing/tagging
ALTER TABLE public.tickets
  ADD COLUMN received_at_email TEXT;
