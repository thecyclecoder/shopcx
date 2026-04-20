-- Customer Demographic Inference — Phase 1b
-- Adds zip_code_demographics (Census cache), customer_demographics, and
-- workspaces.census_api_key_encrypted.

-- 1a. zip_code_demographics (public Census data, no RLS)
CREATE TABLE IF NOT EXISTS public.zip_code_demographics (
  zip_code TEXT PRIMARY KEY,
  median_income INTEGER,
  median_age NUMERIC,
  owner_pct NUMERIC,
  college_pct NUMERIC,
  population INTEGER,
  population_density NUMERIC,
  urban_classification TEXT CHECK (urban_classification IN ('urban', 'suburban', 'rural')),
  income_bracket TEXT CHECK (income_bracket IN (
    'under_40k', '40-60k', '60-80k', '80-100k', '100-125k', '125-150k', '150k+'
  )),
  state TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acs_year INTEGER
);

-- 1b. customer_demographics
CREATE TABLE IF NOT EXISTS public.customer_demographics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  inferred_gender TEXT CHECK (inferred_gender IN ('female', 'male', 'unknown')),
  inferred_gender_conf NUMERIC CHECK (inferred_gender_conf >= 0 AND inferred_gender_conf <= 1),
  inferred_age_range TEXT CHECK (inferred_age_range IN (
    'under_25', '25-34', '35-44', '45-54', '55-64', '65+'
  )),
  inferred_age_conf NUMERIC CHECK (inferred_age_conf >= 0 AND inferred_age_conf <= 1),
  name_inference_notes TEXT,

  zip_code TEXT,
  zip_median_income INTEGER,
  zip_median_age NUMERIC,
  zip_income_bracket TEXT CHECK (zip_income_bracket IN (
    'under_40k', '40-60k', '60-80k', '80-100k', '100-125k', '125-150k', '150k+'
  )),
  zip_urban_classification TEXT CHECK (zip_urban_classification IN ('urban', 'suburban', 'rural')),
  zip_owner_pct NUMERIC,
  zip_college_pct NUMERIC,

  inferred_life_stage TEXT CHECK (inferred_life_stage IN (
    'young_adult', 'family', 'empty_nester', 'retirement_age', 'unknown'
  )),
  health_priorities TEXT[] DEFAULT '{}',
  buyer_type TEXT CHECK (buyer_type IN (
    'value_buyer', 'cautious_buyer', 'committed_subscriber',
    'new_subscriber', 'lapsed_subscriber', 'one_time_buyer'
  )),
  total_orders INTEGER DEFAULT 0,
  total_spend_cents INTEGER DEFAULT 0,
  subscription_tenure_days INTEGER DEFAULT 0,

  enriched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  enrichment_version INTEGER NOT NULL DEFAULT 1,
  census_data_year INTEGER,

  UNIQUE(customer_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_demographics_workspace ON public.customer_demographics(workspace_id);
CREATE INDEX IF NOT EXISTS idx_customer_demographics_gender ON public.customer_demographics(inferred_gender);
CREATE INDEX IF NOT EXISTS idx_customer_demographics_age ON public.customer_demographics(inferred_age_range);
CREATE INDEX IF NOT EXISTS idx_customer_demographics_income ON public.customer_demographics(zip_income_bracket);
CREATE INDEX IF NOT EXISTS idx_customer_demographics_buyer ON public.customer_demographics(buyer_type);

ALTER TABLE public.customer_demographics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read customer_demographics" ON public.customer_demographics;
CREATE POLICY "Authenticated read customer_demographics" ON public.customer_demographics
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Service role full on customer_demographics" ON public.customer_demographics;
CREATE POLICY "Service role full on customer_demographics" ON public.customer_demographics
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 1c. Census API key on workspaces
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS census_api_key_encrypted TEXT;
