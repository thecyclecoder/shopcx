-- Loyalty redemptions: record HOW a redemption was consumed at used_at time.
--
-- Phase 1 of the "mark loyalty redemption used when consumed" contract
-- (docs/brain/specs/loyalty-redemption-marked-used-when-consumed.md).
-- Adds a nullable `consumed_via` text column so the single chokepoint
-- (`consumeRedemption` in src/lib/loyalty.ts) can stamp both `used_at`
-- AND how the reward was delivered on the winning compare-and-set write.
--
-- Values ('order' | 'subscription_renewal' | 'refund') are documented on the
-- column comment; plain text with no CHECK constraint to stay consistent
-- with the sibling `status` column (see 20260708120001_..._rolled_back_status.sql).

ALTER TABLE public.loyalty_redemptions
  ADD COLUMN IF NOT EXISTS consumed_via text;

COMMENT ON COLUMN public.loyalty_redemptions.consumed_via IS
  'How the redemption was consumed at used_at time. Values: order (discount code appeared on a paid order), subscription_renewal (contract carrying the code renewed), refund (paid out as cash via redeem_points_as_refund). NULL when used_at is NULL.';
