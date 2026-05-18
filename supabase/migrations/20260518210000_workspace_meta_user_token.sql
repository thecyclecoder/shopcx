-- Persist the long-lived user access token from Meta OAuth.
--
-- Page Access Tokens (already stored on meta_pages) can hit Graph API for
-- pages/messages/comments, but Meta's Marketing API endpoints — e.g.
-- /{ad_id}?fields=creative... — require a USER access token with ads_read.
-- We were exchanging the short-lived user token for page tokens and then
-- discarding it; now we keep it so we can fetch ad creative destination
-- URLs and match comments to products.
--
-- Stored AES-256-GCM encrypted, same pattern as meta_pages.access_token_encrypted.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS meta_user_access_token_encrypted TEXT;
