-- Expand product_reviews to match Klaviyo API fields + customer association

-- Review type from Klaviyo: review, question, rating, store (store = site-level review)
ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS review_type TEXT NOT NULL DEFAULT 'review' CHECK (review_type IN ('review', 'question', 'rating', 'store'));

-- Status from Klaviyo: published, pending, featured, rejected
ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'pending', 'featured', 'rejected'));

-- Email for customer association
ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS email TEXT;

-- Smart quote (AI-extracted excerpt from Klaviyo)
ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS smart_quote TEXT;

-- Images (photo reviews)
ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS images TEXT[] DEFAULT '{}';

-- Product name cached from Klaviyo (so we don't need joins)
ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS product_name TEXT;

-- Updated timestamp from Klaviyo
ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Customer ID association (resolved from email)
ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES public.customers(id);

-- Index for customer association lookups
CREATE INDEX IF NOT EXISTS idx_reviews_customer ON public.product_reviews(workspace_id, customer_id);

-- Index for status filtering
CREATE INDEX IF NOT EXISTS idx_reviews_status ON public.product_reviews(workspace_id, status);

-- Index for email lookup during sync
CREATE INDEX IF NOT EXISTS idx_reviews_email ON public.product_reviews(workspace_id, email);
