-- Add per-workspace list of "ad destination domains" — the domains that
-- show up in the CTA URLs of the workspace's Meta ads. Used by the
-- social-comments product matcher to recognize an ad's destination URL
-- as belonging to this workspace and look up the products.handle.
--
-- Separate from workspaces.storefront_domain (which is the canonical
-- post-Shopify storefront — different concern). Workspaces commonly
-- run ads pointing at their current Shopify storefront (e.g.
-- superfoodscompany.com) while their storefront_domain points at the
-- future shop.* subdomain. Keeping these orthogonal.
--
-- Admin manages the list at Settings → Integrations → Meta.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS ad_destination_domains TEXT[] NOT NULL DEFAULT '{}'::text[];
