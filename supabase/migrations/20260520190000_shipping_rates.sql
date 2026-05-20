-- Shipping rates — workspace-configurable shipping methods. Each row
-- is a (code, applies_to) combo: e.g. ("economy", "subscription"),
-- ("expedited", "onetime"). Pricing is base_cents + per_item_cents
-- per chargeable item, capped at max_total_cents. Freebies
-- (unit_price_cents = 0) don't count toward per-item shipping.

CREATE TABLE IF NOT EXISTS public.shipping_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL,                          -- 'economy' | 'expedited'
  applies_to TEXT NOT NULL,                    -- 'subscription' | 'onetime'
  name TEXT NOT NULL,                          -- 'Standard shipping'
  description TEXT,                            -- '5-7 business days (US) · 10-14 days (PR)'
  base_cents INTEGER NOT NULL DEFAULT 0,       -- per-order base
  per_item_cents INTEGER NOT NULL DEFAULT 0,   -- per chargeable item
  max_total_cents INTEGER,                     -- cap on total shipping
  transit_days_min INTEGER,                    -- delivery window low
  transit_days_max INTEGER,                    -- delivery window high
  enabled BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,   -- pre-select in checkout
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, code, applies_to)
);

CREATE INDEX IF NOT EXISTS idx_shipping_rates_workspace
  ON public.shipping_rates (workspace_id, applies_to, sort_order)
  WHERE enabled = true;

ALTER TABLE public.shipping_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access shipping_rates" ON public.shipping_rates;
CREATE POLICY "Service role full access shipping_rates"
  ON public.shipping_rates FOR ALL USING (auth.role() = 'service_role');

-- Record which method the order shipped under and the amount charged.
-- We store both the code (so reporting groups stay sane after rates
-- are renamed) and the snapshot of the charged amount.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS shipping_method_code TEXT,
  ADD COLUMN IF NOT EXISTS shipping_rate_id UUID REFERENCES public.shipping_rates(id);

-- Same on subscriptions so renewal billing picks the right rate.
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS shipping_method_code TEXT DEFAULT 'economy',
  ADD COLUMN IF NOT EXISTS shipping_rate_id UUID REFERENCES public.shipping_rates(id);

-- Seed Superfoods.
-- subscription_economy: free, 5-7 day US, 10-14 day PR
-- subscription_expedited: $5.95/item, max $30, 2-5 day
-- onetime_economy: $5.95/item, max $30, 5-7 day US, 10-14 day PR
-- onetime_expedited: $5.95 base + $5.95/item, max $30, 2-5 day
INSERT INTO public.shipping_rates (workspace_id, code, applies_to, name, description, base_cents, per_item_cents, max_total_cents, transit_days_min, transit_days_max, is_default, sort_order)
VALUES
  ('fdc11e10-b89f-4989-8b73-ed6526c4d906', 'economy', 'subscription', 'Standard shipping', '5–7 business days (US) · 10–14 days (PR)', 0, 0, NULL, 5, 7, true, 10),
  ('fdc11e10-b89f-4989-8b73-ed6526c4d906', 'expedited', 'subscription', 'Expedited shipping', '2–5 business days', 0, 595, 3000, 2, 5, false, 20),
  ('fdc11e10-b89f-4989-8b73-ed6526c4d906', 'economy', 'onetime', 'Standard shipping', '5–7 business days (US) · 10–14 days (PR)', 0, 595, 3000, 5, 7, true, 10),
  ('fdc11e10-b89f-4989-8b73-ed6526c4d906', 'expedited', 'onetime', 'Expedited shipping', '2–5 business days', 595, 595, 3000, 2, 5, false, 20)
ON CONFLICT (workspace_id, code, applies_to) DO NOTHING;
