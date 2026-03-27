-- Add description to products for KB minisite product cards
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS description TEXT;
