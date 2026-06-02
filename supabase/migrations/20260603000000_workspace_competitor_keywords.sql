-- Workspace-curated list of competitor brand / product names. Used by
-- the social-comment Pass-1 triage to detect when a commenter is
-- shilling a competitor under our paid creative — that gets the same
-- treatment as spam: delete + ban.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS social_competitor_keywords TEXT;

COMMENT ON COLUMN public.workspaces.social_competitor_keywords IS
  'Free-form list of competitor brand/product names (one per line). When a social comment mentions any of these positively on our ads, Pass-1 classifies as competitor_promotion → delete + ban.';
