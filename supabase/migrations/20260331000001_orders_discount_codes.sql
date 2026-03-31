-- Add discount_codes JSONB column to orders table
-- Stores array of {code, amount, type} from Shopify order discount_codes
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS discount_codes JSONB DEFAULT '[]';
