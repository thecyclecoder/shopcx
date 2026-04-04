-- Store original billing date on dunning cycles for date reset after recovery/exhaustion
ALTER TABLE public.dunning_cycles ADD COLUMN IF NOT EXISTS original_billing_date TIMESTAMPTZ;
