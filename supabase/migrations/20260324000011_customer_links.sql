-- Customer identity linking (non-destructive merge)
CREATE TABLE public.customer_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  group_id UUID NOT NULL,
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(customer_id)
);

CREATE INDEX idx_customer_links_group ON public.customer_links(workspace_id, group_id);
CREATE INDEX idx_customer_links_customer ON public.customer_links(customer_id);

ALTER TABLE public.customer_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view customer links in their workspaces"
  ON public.customer_links FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Service role full access on customer_links"
  ON public.customer_links FOR ALL
  USING (auth.role() = 'service_role');
