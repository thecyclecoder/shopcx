-- Shopify products table
CREATE TABLE public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  shopify_product_id TEXT NOT NULL,
  title TEXT NOT NULL,
  handle TEXT,
  product_type TEXT,
  vendor TEXT,
  status TEXT, -- active, draft, archived
  tags TEXT[] DEFAULT '{}',
  image_url TEXT,
  variants JSONB DEFAULT '[]', -- [{id, title, sku, price_cents}]
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, shopify_product_id)
);

CREATE INDEX idx_products_workspace ON public.products(workspace_id, status);

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view products in their workspace" ON public.products FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full access on products" ON public.products FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Map macros to products
ALTER TABLE public.macros ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES public.products(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_macros_product ON public.macros(product_id) WHERE product_id IS NOT NULL;
