-- Returns table and workspace settings for Shopify Returns integration

CREATE TABLE IF NOT EXISTS public.returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  order_id UUID REFERENCES public.orders(id),
  order_number TEXT NOT NULL,
  shopify_order_gid TEXT NOT NULL,
  customer_id UUID REFERENCES public.customers(id),
  ticket_id UUID REFERENCES public.tickets(id),

  -- Shopify return IDs
  shopify_return_gid TEXT,
  shopify_reverse_fulfillment_order_gid TEXT,
  shopify_reverse_delivery_gid TEXT,

  -- Status
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'open', 'label_created', 'in_transit', 'delivered',
    'processing', 'restocked', 'refunded', 'closed', 'cancelled'
  )),

  -- Resolution
  resolution_type TEXT NOT NULL CHECK (resolution_type IN (
    'store_credit_return', 'refund_return', 'store_credit_no_return', 'refund_no_return'
  )),
  source TEXT NOT NULL DEFAULT 'playbook' CHECK (source IN ('playbook', 'agent', 'portal', 'shopify')),

  -- Financials
  order_total_cents INTEGER NOT NULL DEFAULT 0,
  label_cost_cents INTEGER NOT NULL DEFAULT 0,
  net_refund_cents INTEGER NOT NULL DEFAULT 0,
  refund_id TEXT,

  -- Tracking
  tracking_number TEXT,
  carrier TEXT,
  label_url TEXT,
  easypost_shipment_id TEXT,

  -- Line items being returned
  return_line_items JSONB NOT NULL DEFAULT '[]',

  -- Timestamps
  shipped_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.returns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read returns" ON public.returns FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full on returns" ON public.returns FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX idx_returns_workspace ON public.returns (workspace_id, status, created_at DESC);
CREATE INDEX idx_returns_order ON public.returns (order_number);
CREATE INDEX idx_returns_tracking ON public.returns (tracking_number) WHERE tracking_number IS NOT NULL;

-- Workspace settings for returns
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS return_address JSONB;
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS easypost_api_key_encrypted TEXT;
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS default_return_parcel JSONB DEFAULT '{"length": 12, "width": 10, "height": 6, "weight": 16}';
