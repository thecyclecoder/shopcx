-- Sales-tax quote storage on subscriptions. Used by the customer
-- portal so we can display "you'll be charged $X total per renewal"
-- without round-tripping to Avalara on every page load.
--
-- Refresh rules (enforced in code, not DB):
--   • First time we render the portal sub detail → quote + save
--   • Any subscription mutation bumps updated_at — if updated_at >
--     avalara_quote_at the next portal load re-quotes
--   • Renewal billing uses a fresh commit=true call, ignoring the
--     stored quote (so the customer's charged amount is always
--     authoritative for filing)
--
-- avalara_quote_address is a frozen copy of the shipTo we used for
-- the quote. Helpful for debugging when the displayed tax doesn't
-- match the charged tax.

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS avalara_quote_tax_cents INTEGER,
  ADD COLUMN IF NOT EXISTS avalara_quote_total_cents INTEGER,
  ADD COLUMN IF NOT EXISTS avalara_quote_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS avalara_quote_address JSONB;

COMMENT ON COLUMN public.subscriptions.avalara_quote_tax_cents IS
  'Cents of sales tax forecast for the next renewal. Quoted via Avalara SalesOrder (no filing). Refreshed when the sub mutates.';
COMMENT ON COLUMN public.subscriptions.avalara_quote_total_cents IS
  'Items + shipping + protection + tax total the customer will see in the portal. Quoted at the same time as avalara_quote_tax_cents.';
