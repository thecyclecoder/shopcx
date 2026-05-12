-- Extend pricing_rules with subscription terms + conditional perks.
-- The storefront price table is moving from product_pricing_tiers
-- (per-product hard-coded prices) to pricing_rules (one rule, applied
-- to many products, augmenting their base variant price with quantity
-- discounts + subscription terms + perks).
--
--  - subscribe_discount_pct: flat % off when subscribing (e.g. 25)
--  - available_frequencies: array of { interval_days, label, default }
--    rendered as a frequency picker when subscribe mode is active.
--    Empty array = no frequency picker, single implicit frequency.
--  - free_shipping_subscription_only: when true, the "free shipping"
--    bullet only applies when the customer is subscribing.
--  - free_gift_subscription_only: same idea for the free gift line.

ALTER TABLE public.pricing_rules
  ADD COLUMN IF NOT EXISTS subscribe_discount_pct INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS available_frequencies JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS free_shipping_subscription_only BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS free_gift_subscription_only BOOLEAN NOT NULL DEFAULT false;
