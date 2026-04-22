-- Amazon SP-API integration for sales data (ROAS calculator)

-- Amazon seller connection (credentials + token cache)
CREATE TABLE public.amazon_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL,
  marketplace_id TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER', -- US marketplace
  refresh_token_encrypted TEXT NOT NULL,
  access_token_encrypted TEXT,
  access_token_expires_at TIMESTAMPTZ,
  seller_name TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, seller_id)
);

-- Amazon product catalog (ASINs)
CREATE TABLE public.amazon_asins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  amazon_connection_id UUID NOT NULL REFERENCES public.amazon_connections(id) ON DELETE CASCADE,
  asin TEXT NOT NULL,
  sku TEXT,
  title TEXT,
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'Active',
  product_id UUID REFERENCES public.products(id), -- map to our product catalog
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(amazon_connection_id, asin)
);

-- Amazon sales channels (one_time, recurring, sns_checkout)
CREATE TABLE public.amazon_sales_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  amazon_connection_id UUID NOT NULL REFERENCES public.amazon_connections(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL, -- one_time, recurring, sns_checkout
  channel_name TEXT NOT NULL,
  order_count INTEGER NOT NULL DEFAULT 0,
  include_in_roas BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(amazon_connection_id, channel_id)
);

-- Daily Amazon order snapshots (aggregated by day + order bucket)
CREATE TABLE public.daily_amazon_order_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  amazon_connection_id UUID NOT NULL REFERENCES public.amazon_connections(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  order_bucket TEXT NOT NULL, -- one_time, recurring, sns_checkout
  order_count INTEGER NOT NULL DEFAULT 0,
  gross_revenue_cents INTEGER NOT NULL DEFAULT 0,
  net_revenue_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(amazon_connection_id, snapshot_date, order_bucket)
);

CREATE INDEX idx_amazon_snapshots_date ON daily_amazon_order_snapshots(workspace_id, snapshot_date DESC);

-- RLS
ALTER TABLE public.amazon_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.amazon_asins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.amazon_sales_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_amazon_order_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth read amazon_connections" ON public.amazon_connections
  FOR SELECT TO authenticated USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full amazon_connections" ON public.amazon_connections FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Auth read amazon_asins" ON public.amazon_asins
  FOR SELECT TO authenticated USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full amazon_asins" ON public.amazon_asins FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Auth read amazon_sales_channels" ON public.amazon_sales_channels
  FOR SELECT TO authenticated USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full amazon_sales_channels" ON public.amazon_sales_channels FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Auth read daily_amazon_order_snapshots" ON public.daily_amazon_order_snapshots
  FOR SELECT TO authenticated USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full daily_amazon_order_snapshots" ON public.daily_amazon_order_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT ALL ON amazon_connections TO service_role;
GRANT ALL ON amazon_asins TO service_role;
GRANT ALL ON amazon_sales_channels TO service_role;
GRANT ALL ON daily_amazon_order_snapshots TO service_role;
GRANT SELECT ON amazon_connections TO authenticated;
GRANT SELECT ON amazon_asins TO authenticated;
GRANT SELECT ON amazon_sales_channels TO authenticated;
GRANT SELECT ON daily_amazon_order_snapshots TO authenticated;
