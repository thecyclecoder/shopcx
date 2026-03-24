ALTER TABLE public.orders
  ADD COLUMN fulfillments JSONB DEFAULT '[]';
