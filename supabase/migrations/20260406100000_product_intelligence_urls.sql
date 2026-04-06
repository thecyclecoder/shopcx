-- Replace simple source_urls array with labeled URLs
ALTER TABLE public.product_intelligence ADD COLUMN IF NOT EXISTS labeled_urls JSONB NOT NULL DEFAULT '[]';
-- Format: [{ "url": "https://...", "label": "Reviews" }, ...]
