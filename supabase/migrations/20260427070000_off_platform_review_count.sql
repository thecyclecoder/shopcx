-- Off-platform review count bump per workspace. Customer-facing review counts
-- on the storefront include this offset so social proof reflects total volume
-- (e.g. Amazon, retail) — not just what's synced into product_reviews.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS storefront_off_platform_review_count INTEGER NOT NULL DEFAULT 0;

-- Seed the existing Superfoods Company value (~10K off-platform reviews).
UPDATE public.workspaces
SET storefront_off_platform_review_count = 10000
WHERE id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906';
