-- Track which specific payment methods returned terminal errors during a dunning cycle
-- Uses dedupeKey format (last4+expiryMonth+expiryYear) to match card rotation logic
ALTER TABLE dunning_cycles ADD COLUMN IF NOT EXISTS terminal_cards TEXT[] DEFAULT '{}';
