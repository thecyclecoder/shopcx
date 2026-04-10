-- Store the customer's original base price so swaps (tier 1, 2, Sonnet) can preserve it
ALTER TABLE crisis_customer_actions ADD COLUMN IF NOT EXISTS preserved_base_price_cents integer;
