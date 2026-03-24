-- Add order source tracking for recurring vs one-time
ALTER TABLE public.orders
  ADD COLUMN source_name TEXT,
  ADD COLUMN app_id BIGINT,
  ADD COLUMN tags TEXT;

CREATE INDEX idx_orders_source ON public.orders(workspace_id, source_name);
