-- Allow manual resolution of sync errors without faking fulfillment status
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS sync_resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sync_resolved_note TEXT;
