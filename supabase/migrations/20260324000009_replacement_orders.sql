-- Add 'replacement' to order_type options
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_order_type_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_order_type_check
  CHECK (order_type IN ('checkout', 'recurring', 'replacement', 'unknown'));

-- Add replacement threshold to workspace settings
ALTER TABLE public.workspaces
  ADD COLUMN replacement_threshold_cents BIGINT NOT NULL DEFAULT 0;
