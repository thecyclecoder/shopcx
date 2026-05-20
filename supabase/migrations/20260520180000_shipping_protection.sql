-- Shipping protection — a digital line item (no inventory, doesn't
-- ship) the customer can opt into at checkout. Workspace-configurable
-- price/copy; per-order + per-subscription flag tracks who opted in
-- so the renewal scheduler keeps charging it on each cycle.
--
-- Amplifier behavior: shipping protection does NOT go in the
-- order_items array we send to Amplifier (there's nothing to
-- fulfill). The order row is still marked so the dashboard / customer
-- service can see "this customer paid for protection if anything
-- goes wrong in transit".

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS shipping_protection_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shipping_protection_price_cents INTEGER NOT NULL DEFAULT 495,
  ADD COLUMN IF NOT EXISTS shipping_protection_title TEXT NOT NULL DEFAULT 'Shipping protection',
  ADD COLUMN IF NOT EXISTS shipping_protection_description TEXT NOT NULL DEFAULT 'Protect this order against loss, damage or theft during shipping.';

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS shipping_protection_added BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shipping_protection_amount_cents INTEGER;

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS shipping_protection_added BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shipping_protection_amount_cents INTEGER;

-- Seed the Superfoods workspace so the product team can test today.
-- Other workspaces stay disabled by default until they configure it.
UPDATE public.workspaces
  SET shipping_protection_enabled = true,
      shipping_protection_price_cents = 495
  WHERE id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906';
