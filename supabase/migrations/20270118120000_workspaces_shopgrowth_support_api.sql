-- software-mode-orchestrator-toolset Phase 2 — per-workspace ShopGrowth support API credentials.
--
-- The software-mode orchestrator reads the merchant's live store state (get_shopgrowth_store) and
-- executes confirmed store actions (shopgrowth_action) through ShopGrowth's support API. Store data
-- stays in ShopGrowth; only the base URL and an encrypted bearer token live here.
--
--   shopgrowth_api_base                 — e.g. https://app.shopgrowth.example (no trailing slash needed)
--   shopgrowth_support_token_encrypted  — AES-256-GCM ciphertext from src/lib/crypto.ts `encrypt`.
--                                         Set from the settings UI or a one-off encrypted write;
--                                         never a plaintext token, never in code.
--
-- Additive + idempotent. NULL on every existing workspace, which reads as "not connected".

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS shopgrowth_api_base text,
  ADD COLUMN IF NOT EXISTS shopgrowth_support_token_encrypted text;

COMMENT ON COLUMN public.workspaces.shopgrowth_api_base IS
  'ShopGrowth support API base URL for software-mode workspaces (software-mode-orchestrator-toolset). NULL = not connected.';
COMMENT ON COLUMN public.workspaces.shopgrowth_support_token_encrypted IS
  'AES-256-GCM (src/lib/crypto.ts) bearer token for the ShopGrowth support API. Never plaintext.';
