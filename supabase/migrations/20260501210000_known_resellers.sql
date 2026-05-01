-- Known resellers — operators we've identified buying from our store
-- with coupons and reselling on Amazon (or elsewhere). Discovered by
-- scanning SP-API for who else is competing on our ASINs and scraping
-- their Amazon storefront for the registered business name + address.
--
-- Used by:
--   - reseller-address fraud rule (fuzzy address match against an
--     incoming order's ship/bill)
--   - weekly cron that re-scans Amazon to discover new entrants
--   - admin review screen at /dashboard/settings/fraud-detection/resellers

CREATE TABLE IF NOT EXISTS public.known_resellers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- Identification (Amazon for now; other platforms later)
  platform TEXT NOT NULL DEFAULT 'amazon',
  amazon_seller_id TEXT,                                  -- e.g. A3DAHS47KFVRW
  business_name TEXT,                                     -- e.g. "Carter Distributors LLC"

  -- Registered business address (from Amazon storefront scrape)
  address1 TEXT,
  address2 TEXT,
  city TEXT,
  state TEXT,                                             -- 2-letter or full
  zip TEXT,
  country TEXT DEFAULT 'US',

  -- Pre-normalized form for fast SQL exact-equality lookup. Fuzzy
  -- matching for variants ("010083 Lynden Ova.l" vs "10083 Lynden Oval")
  -- happens in the fraud rule via Haiku.
  normalized_address TEXT,

  -- Which of our ASINs this reseller has been spotted competing on
  source_asins TEXT[] DEFAULT '{}',

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'dormant', 'whitelisted', 'unverified')),
  -- 'active'      = in scope; fraud rule blocks orders to this address
  -- 'dormant'     = no longer competing on Amazon; keep for history
  -- 'whitelisted' = manually approved (e.g. legitimate B2B partner)
  -- 'unverified'  = newly discovered, awaiting admin review

  notes TEXT,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, platform, amazon_seller_id)
);

CREATE INDEX IF NOT EXISTS idx_known_resellers_workspace_status
  ON public.known_resellers(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_known_resellers_zip
  ON public.known_resellers(zip);
CREATE INDEX IF NOT EXISTS idx_known_resellers_normalized
  ON public.known_resellers(normalized_address);

-- RLS
ALTER TABLE public.known_resellers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read known_resellers" ON public.known_resellers;
CREATE POLICY "Authenticated read known_resellers"
  ON public.known_resellers FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Service role full on known_resellers" ON public.known_resellers;
CREATE POLICY "Service role full on known_resellers"
  ON public.known_resellers FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Track every fraud-related action we take against a reseller-tied
-- account so there's a clean audit trail (cancellations, bans, etc.)
CREATE TABLE IF NOT EXISTS public.fraud_action_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  fraud_case_id UUID REFERENCES public.fraud_cases(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  reseller_id UUID REFERENCES public.known_resellers(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  -- e.g. 'subscription_cancelled', 'customer_banned', 'order_held',
  --      'reseller_discovered', 'address_match_flagged'
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fraud_action_log_customer
  ON public.fraud_action_log(workspace_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_fraud_action_log_reseller
  ON public.fraud_action_log(workspace_id, reseller_id);

ALTER TABLE public.fraud_action_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read fraud_action_log" ON public.fraud_action_log;
CREATE POLICY "Authenticated read fraud_action_log"
  ON public.fraud_action_log FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Service role full on fraud_action_log" ON public.fraud_action_log;
CREATE POLICY "Service role full on fraud_action_log"
  ON public.fraud_action_log FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Add 'banned' flag to customers for the ban-customer-profiles step.
-- Existing 'tags' could carry it but a dedicated boolean is faster
-- to filter on (and the orchestrator's pre-flight check needs to be cheap).
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS banned_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_banned
  ON public.customers(workspace_id, banned)
  WHERE banned = true;

-- Add 'amazon_reseller' as a recognized fraud case_type via a comment
-- since fraud_cases.case_type is already a free-text column.
COMMENT ON TABLE public.known_resellers IS
  'Discovered Amazon resellers who buy from our Shopify store with coupons and resell. Populated by SP-API scan + storefront scrape. Used by fraud rule (case_type = ''amazon_reseller'') to flag matching ship/bill addresses.';
