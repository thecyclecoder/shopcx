-- Avalara (AvaTax) integration for the new custom storefront + in-house
-- subscription scheduler. Tax calc + reporting source-of-truth for any
-- order/renewal that goes through OUR flow (not Shopify orders — those
-- continue to use Shopify's tax calc until cutover).
--
-- Auth is Basic: account_id as username, license key as password.
-- Sandbox: https://sandbox-rest.avatax.com/
-- Production: https://rest.avatax.com/
--
-- Each transaction is identified by our internal order code so retries
-- are idempotent. `commit=false` quotes tax at checkout review; on
-- successful payment we re-call with `commit=true` to lock it in for
-- reporting/filing.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS avalara_account_id TEXT,
  ADD COLUMN IF NOT EXISTS avalara_license_key_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS avalara_company_code TEXT,
  ADD COLUMN IF NOT EXISTS avalara_environment TEXT,           -- 'sandbox' | 'production'
  ADD COLUMN IF NOT EXISTS avalara_origin_address JSONB,
  ADD COLUMN IF NOT EXISTS avalara_default_tax_code TEXT,      -- fallback when product has no code
  ADD COLUMN IF NOT EXISTS avalara_enabled BOOLEAN NOT NULL DEFAULT false;

-- Per-product AvaTax tax code. NULL = use workspace default. Examples:
--   PF050144  - dietary supplements (Tabs, Coffee, Creamer, ACV, etc.)
--   P0000000  - generic taxable merchandise (Mug, Tumbler, Mixer)
--   OS        - shipping insurance (Shipping Protection)
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS avalara_tax_code TEXT;

-- Track the Avalara transaction on orders we put through Avalara.
-- avalara_transaction_code = our order code (e.g., "SC131727") echoed back.
-- avalara_total_tax_cents = total tax across all line items, locked in at commit time.
-- avalara_committed_at = when we successfully committed (status=committed in Avalara).
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS avalara_transaction_code TEXT,
  ADD COLUMN IF NOT EXISTS avalara_total_tax_cents INTEGER,
  ADD COLUMN IF NOT EXISTS avalara_committed_at TIMESTAMPTZ;

-- Same on cart_drafts so we can store the pre-checkout quote.
ALTER TABLE public.cart_drafts
  ADD COLUMN IF NOT EXISTS avalara_quote_tax_cents INTEGER,
  ADD COLUMN IF NOT EXISTS avalara_quote_at TIMESTAMPTZ;

COMMENT ON COLUMN public.workspaces.avalara_origin_address IS
  'Ship-from address for AvaTax. JSON shape: { line1, city, region (2-letter), postalCode, country (2-letter) }. Drives jurisdictional sourcing rules.';
