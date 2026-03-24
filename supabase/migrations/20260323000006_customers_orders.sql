-- Phase 2: Customers & Orders

-- Customers table
CREATE TABLE public.customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  shopify_customer_id TEXT,
  stripe_customer_id TEXT,
  retention_score INTEGER DEFAULT 50 CHECK (retention_score >= 0 AND retention_score <= 100),
  subscription_status TEXT DEFAULT 'never' CHECK (subscription_status IN ('active','paused','cancelled','never')),
  subscription_tenure_days INTEGER DEFAULT 0,
  total_orders INTEGER DEFAULT 0,
  ltv_cents BIGINT DEFAULT 0,
  first_order_at TIMESTAMPTZ,
  last_order_at TIMESTAMPTZ,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, email),
  UNIQUE(workspace_id, shopify_customer_id)
);

CREATE INDEX idx_customers_workspace ON public.customers(workspace_id);
CREATE INDEX idx_customers_retention ON public.customers(workspace_id, retention_score);
CREATE INDEX idx_customers_email ON public.customers(workspace_id, email);

-- Orders table
CREATE TABLE public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  shopify_order_id TEXT NOT NULL,
  order_number TEXT,
  email TEXT,
  total_cents BIGINT DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  financial_status TEXT,
  fulfillment_status TEXT,
  line_items JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, shopify_order_id)
);

CREATE INDEX idx_orders_workspace ON public.orders(workspace_id);
CREATE INDEX idx_orders_customer ON public.orders(customer_id);

-- RLS for customers
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view customers in their workspaces"
  ON public.customers FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Service role full access on customers"
  ON public.customers FOR ALL
  USING (auth.role() = 'service_role');

-- RLS for orders
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view orders in their workspaces"
  ON public.orders FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Service role full access on orders"
  ON public.orders FOR ALL
  USING (auth.role() = 'service_role');
