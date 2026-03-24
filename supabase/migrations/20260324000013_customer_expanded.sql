-- Expanded customer fields from Shopify
ALTER TABLE public.customers
  ADD COLUMN default_address JSONB,
  ADD COLUMN addresses JSONB DEFAULT '[]',
  ADD COLUMN locale TEXT,
  ADD COLUMN note TEXT,
  ADD COLUMN shopify_state TEXT,
  ADD COLUMN valid_email BOOLEAN DEFAULT true,
  ADD COLUMN shopify_created_at TIMESTAMPTZ;
