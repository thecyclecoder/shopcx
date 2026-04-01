-- Track delivery status from Shopify fulfillment events
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivery_status TEXT,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
