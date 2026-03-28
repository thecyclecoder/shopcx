-- Cancel journey: remedies, remedy_outcomes, product_reviews tables + Klaviyo fields on workspaces

-- Remedies table
CREATE TABLE public.remedies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('coupon', 'pause', 'skip', 'frequency_change', 'product_swap', 'free_gift', 'social_proof', 'ai_conversation', 'specialist')),
  config JSONB NOT NULL DEFAULT '{}',
  description TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_remedies_workspace ON public.remedies(workspace_id, enabled, priority);

ALTER TABLE public.remedies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view remedies in workspace" ON public.remedies FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full access on remedies" ON public.remedies FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Remedy outcomes table
CREATE TABLE public.remedy_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES public.customers(id),
  subscription_id UUID REFERENCES public.subscriptions(id),
  cancel_reason TEXT NOT NULL,
  remedy_id UUID REFERENCES public.remedies(id),
  remedy_type TEXT NOT NULL,
  offered_text TEXT,
  accepted BOOLEAN NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('saved', 'cancelled', 'escalated')),
  customer_ltv_cents INTEGER,
  subscription_age_days INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_remedy_outcomes_reason ON public.remedy_outcomes(workspace_id, cancel_reason, remedy_type);
-- Track first-renewal cancellers separately for metrics
ALTER TABLE public.remedy_outcomes ADD COLUMN IF NOT EXISTS first_renewal BOOLEAN DEFAULT false;

ALTER TABLE public.remedy_outcomes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view remedy outcomes in workspace" ON public.remedy_outcomes FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full access on remedy_outcomes" ON public.remedy_outcomes FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Product reviews table
CREATE TABLE public.product_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  shopify_product_id TEXT NOT NULL,
  reviewer_name TEXT,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  title TEXT,
  body TEXT,
  summary TEXT,
  verified_purchase BOOLEAN DEFAULT false,
  featured BOOLEAN DEFAULT false,
  klaviyo_review_id TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, klaviyo_review_id)
);

CREATE INDEX idx_reviews_product ON public.product_reviews(workspace_id, shopify_product_id, featured, rating DESC);

ALTER TABLE public.product_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view reviews in workspace" ON public.product_reviews FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full access on product_reviews" ON public.product_reviews FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Add Klaviyo fields to workspaces
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS klaviyo_api_key_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS klaviyo_public_key TEXT,
  ADD COLUMN IF NOT EXISTS klaviyo_last_sync_at TIMESTAMPTZ;
