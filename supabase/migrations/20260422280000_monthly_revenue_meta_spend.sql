-- Add Meta ad spend to monthly revenue snapshots
ALTER TABLE public.monthly_revenue_snapshots ADD COLUMN IF NOT EXISTS meta_spend_cents INTEGER NOT NULL DEFAULT 0;
