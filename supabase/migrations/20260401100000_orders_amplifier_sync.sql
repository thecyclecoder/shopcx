-- Orders: Amplifier 3PL sync columns
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS amplifier_order_id UUID,
  ADD COLUMN IF NOT EXISTS amplifier_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS amplifier_shipped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS amplifier_tracking_number TEXT,
  ADD COLUMN IF NOT EXISTS amplifier_carrier TEXT,
  ADD COLUMN IF NOT EXISTS amplifier_status TEXT;

-- Index for webhook lookups by order_number
CREATE INDEX IF NOT EXISTS idx_orders_order_number ON public.orders (workspace_id, order_number);

-- Index for amplifier_order_id lookups
CREATE INDEX IF NOT EXISTS idx_orders_amplifier_order_id ON public.orders (amplifier_order_id) WHERE amplifier_order_id IS NOT NULL;

-- Workspaces: Amplifier SLA settings
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS amplifier_tracking_sla_days INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS amplifier_cutoff_hour INTEGER DEFAULT 11,
  ADD COLUMN IF NOT EXISTS amplifier_cutoff_timezone TEXT DEFAULT 'America/Chicago',
  ADD COLUMN IF NOT EXISTS amplifier_shipping_days INTEGER[] DEFAULT '{1,2,3,4,5}',
  ADD COLUMN IF NOT EXISTS amplifier_webhook_token_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS amplifier_webhook_received_id TEXT,
  ADD COLUMN IF NOT EXISTS amplifier_webhook_shipped_id TEXT;
