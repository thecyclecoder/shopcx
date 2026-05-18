-- Stamp the resolved customer on each shortlink click. Enables per-customer
-- click attribution and is the basis of the storefront identity-stitch
-- (Component 1 of PERPETUAL-CAMPAIGNS-SPEC.md) — every shortlink click now
-- ties a click to a specific customer when the URL contains a short_code.

ALTER TABLE marketing_shortlink_clicks
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS marketing_shortlink_clicks_customer_idx
  ON marketing_shortlink_clicks (customer_id, clicked_at DESC)
  WHERE customer_id IS NOT NULL;
