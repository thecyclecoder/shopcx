-- Hash-based freshness for the cached subscription tax quote.
--
-- The old check compared avalara_quote_at to subscriptions.updated_at. That
-- breaks under DYNAMIC pricing: a catalog price change or a pricing-rule edit
-- re-prices the sub WITHOUT touching the sub row, so updated_at doesn't move and a
-- stale quote would be served. We now key the cached quote to a hash of its actual
-- tax inputs (engine-priced lines + ship-to address + shipping/protection cents);
-- a mismatch forces a re-quote. Immune to missed updated_at bumps AND to
-- catalog/rule drift that never touches the sub row.

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS avalara_quote_hash TEXT;

COMMENT ON COLUMN public.subscriptions.avalara_quote_hash IS
  'Hash of the tax inputs (engine-priced lines + ship-to + shipping/protection) the cached avalara_quote_* was computed from. ensureFreshSubscriptionTaxQuote re-quotes when the current hash differs — robust to dynamic pricing where updated_at would not change.';
