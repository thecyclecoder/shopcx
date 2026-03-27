-- Track rejected profile link suggestions so we don't re-offer them
CREATE TABLE IF NOT EXISTS public.customer_link_rejections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  rejected_customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(customer_id, rejected_customer_id)
);

ALTER TABLE public.customer_link_rejections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on link rejections" ON public.customer_link_rejections FOR ALL TO service_role USING (true) WITH CHECK (true);
