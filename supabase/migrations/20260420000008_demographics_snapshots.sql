-- Pre-computed demographics summaries — rebuilt nightly by Inngest cron
CREATE TABLE public.demographics_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id) ON DELETE CASCADE,  -- NULL = all customers
  total_customers INTEGER NOT NULL DEFAULT 0,
  enriched_count INTEGER NOT NULL DEFAULT 0,
  gender_distribution JSONB NOT NULL DEFAULT '{}',
  age_distribution JSONB NOT NULL DEFAULT '{}',
  income_distribution JSONB NOT NULL DEFAULT '{}',
  urban_distribution JSONB NOT NULL DEFAULT '{}',
  buyer_type_distribution JSONB NOT NULL DEFAULT '{}',
  top_health_priorities JSONB NOT NULL DEFAULT '[]',
  suggested_target_customer TEXT,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, product_id)
);

-- NULL product_id needs a special unique constraint
CREATE UNIQUE INDEX idx_demographics_snapshots_all
  ON public.demographics_snapshots(workspace_id)
  WHERE product_id IS NULL;

CREATE INDEX idx_demographics_snapshots_workspace ON public.demographics_snapshots(workspace_id);

ALTER TABLE public.demographics_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read demographics_snapshots" ON public.demographics_snapshots
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full on demographics_snapshots" ON public.demographics_snapshots
  FOR ALL TO service_role USING (true) WITH CHECK (true);
