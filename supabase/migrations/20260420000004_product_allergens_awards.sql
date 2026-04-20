-- Add allergen-free claims and awards/press to products
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS allergen_free TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS awards TEXT[] DEFAULT '{}';
