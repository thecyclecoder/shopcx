-- Ensure only one active/skipped/paused dunning cycle per contract at a time.
-- This prevents race conditions where two billing-failure webhooks create duplicate cycles.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dunning_cycles_active_contract
  ON public.dunning_cycles (workspace_id, shopify_contract_id)
  WHERE status IN ('active', 'skipped', 'paused');
