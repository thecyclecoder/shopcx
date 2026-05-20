-- Internal subscription flag
--
-- Subscriptions managed entirely by shopcx (post-Shopify, post-Appstle)
-- carry is_internal = true. Every Appstle helper checks this flag and
-- routes mutations through DB updates instead of Appstle API calls.
-- Lets us run the new native subscription engine alongside the existing
-- Appstle-backed subs without rebuilding any portal UI.

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_subscriptions_is_internal
  ON public.subscriptions(workspace_id, is_internal)
  WHERE is_internal = true;
