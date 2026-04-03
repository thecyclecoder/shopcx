-- Store applied discounts on subscriptions locally (synced from Appstle webhooks)
-- Eliminates need to query Appstle contract-raw-response for discount info
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS applied_discounts JSONB NOT NULL DEFAULT '[]';
