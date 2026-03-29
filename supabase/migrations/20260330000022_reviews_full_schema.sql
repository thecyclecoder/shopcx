-- Add missing columns to product_reviews (original migration 21 may have run without these)
-- These match Klaviyo API fields exactly

-- Review type from Klaviyo: review, question, rating, store
ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS review_type TEXT NOT NULL DEFAULT 'review';

-- Drop and recreate check constraint if it exists (safe for both fresh and upgrade paths)
ALTER TABLE public.product_reviews DROP CONSTRAINT IF EXISTS product_reviews_review_type_check;
ALTER TABLE public.product_reviews ADD CONSTRAINT product_reviews_review_type_check
  CHECK (review_type IN ('review', 'question', 'rating', 'store'));

-- Status from Klaviyo: published, unpublished, pending, featured, rejected
ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';

ALTER TABLE public.product_reviews DROP CONSTRAINT IF EXISTS product_reviews_status_check;
ALTER TABLE public.product_reviews ADD CONSTRAINT product_reviews_status_check
  CHECK (status IN ('published', 'unpublished', 'pending', 'featured', 'rejected'));

-- Email for customer association
ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS email TEXT;

-- Smart quote (AI-extracted excerpt from Klaviyo)
ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS smart_quote TEXT;

-- Images (photo reviews)
ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS images TEXT[] DEFAULT '{}';

-- Product name cached from Klaviyo
ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS product_name TEXT;

-- Updated timestamp from Klaviyo
ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Customer ID association (resolved from email)
ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES public.customers(id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_reviews_customer ON public.product_reviews(workspace_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON public.product_reviews(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_reviews_email ON public.product_reviews(workspace_id, email);

-- Add Klaviyo fields to workspaces (in case migration 21 didn't include them)
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS klaviyo_api_key_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS klaviyo_public_key TEXT,
  ADD COLUMN IF NOT EXISTS klaviyo_last_sync_at TIMESTAMPTZ;

-- Add first_renewal to remedy_outcomes (in case migration 21 didn't include it)
ALTER TABLE public.remedy_outcomes
  ADD COLUMN IF NOT EXISTS first_renewal BOOLEAN DEFAULT false;
