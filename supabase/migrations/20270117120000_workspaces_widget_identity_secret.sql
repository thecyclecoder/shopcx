-- Per-workspace secret for the chat widget's signed identity pass.
--
-- Spec: widget-signed-identity-pass (Phase 1). In ShopGrowth's embedded Shopify admin app the
-- person chatting is staff of a specific store, and only ShopGrowth can prove which (Shopify
-- session token). ShopGrowth mints a short-lived HMAC-SHA256 pass signed with THIS secret; the
-- widget API verifies it (src/lib/widget-identity.ts `verifyWidgetIdentity`) before keying the
-- contact to the store. The same secret lives in ShopGrowth's env so it can sign.
--
-- AES-256-GCM encrypted at rest via src/lib/crypto.ts (CLAUDE.md: credential columns end
-- `_encrypted`). Null until a workspace enables verified identity; a null secret means every pass
-- fails to verify (software-mode chats are then rejected, cpg falls back to typed email).

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS widget_identity_secret_encrypted text;
