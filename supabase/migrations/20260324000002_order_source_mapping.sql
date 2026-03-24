-- Workspace-level mapping of Shopify source_name to order type (checkout | recurring)
ALTER TABLE public.workspaces
  ADD COLUMN order_source_mapping JSONB DEFAULT '{}';

-- Add derived order_type column to orders
ALTER TABLE public.orders
  ADD COLUMN order_type TEXT CHECK (order_type IN ('checkout', 'recurring', 'unknown'));
