-- Add timezone to customers table (derived from shipping address state/zip)
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS timezone TEXT;

CREATE INDEX idx_customers_timezone ON public.customers(timezone) WHERE timezone IS NOT NULL;
