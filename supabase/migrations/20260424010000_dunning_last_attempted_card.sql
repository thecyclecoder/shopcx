-- Track which card was last attempted on a dunning cycle.
-- Used by the billing-failure webhook to identify which card failed
-- (the webhook payload from Appstle never includes last4 directly).
ALTER TABLE dunning_cycles ADD COLUMN IF NOT EXISTS last_attempted_last4 TEXT;
