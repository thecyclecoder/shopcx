-- Document the `rolled_back` status value on loyalty_redemptions.
--
-- The atomic redeem→apply guardrail (see src/lib/action-executor.ts
-- rollbackLoyaltyRedemptionOnApplyFailure) marks a redemption
-- `rolled_back` when its paired apply_(loyalty_)coupon didn't land on
-- the target — points are re-credited via earnPoints and the row is
-- flipped from `active` to `rolled_back`. Column is plain text with no
-- CHECK constraint; this migration only refreshes the comment so the
-- schema documents the contract. Ticket 0a9e4d7f (Judy).
COMMENT ON COLUMN public.loyalty_redemptions.status IS
  'active=ready, applied=on subscription waiting for charge, used=consumed on order, expired=past expiry, rolled_back=re-credited after paired apply_loyalty_coupon failed';
