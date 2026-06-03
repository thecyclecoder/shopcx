-- Ad tool — persist generated avatar FACE candidates so they're reusable.
--
-- "Generate 3 faces" costs Soul credits each run. Without persistence, the two
-- faces the operator doesn't pick (and all faces if they navigate away before
-- creating) are orphaned in storage with no DB reference — so they'd regenerate
-- and burn credits again. This table is the saved-faces library: every
-- generated face is recorded with its attributes + persistent storage_path, and
-- the avatar-creation screen shows the existing library before offering to
-- generate more.

CREATE TABLE IF NOT EXISTS public.ad_avatar_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  proposal_id UUID REFERENCES public.ad_avatar_proposals(id) ON DELETE SET NULL,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,

  -- The four face attributes the operator generated with.
  gender TEXT,
  age_range TEXT,
  health_level TEXT,
  ethnicity TEXT,

  -- Persistent path in the private ad-tool bucket (re-signed on read — never
  -- store the expiring signed URL).
  storage_path TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'available',   -- available | used | discarded
  used_avatar_id UUID REFERENCES public.ad_avatars(id) ON DELETE SET NULL,

  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ad_avatar_candidates_lookup_idx
  ON public.ad_avatar_candidates (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ad_avatar_candidates_proposal_idx
  ON public.ad_avatar_candidates (proposal_id);

ALTER TABLE public.ad_avatar_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ad_avatar_candidates_select_own_workspace" ON public.ad_avatar_candidates;
DROP POLICY IF EXISTS "ad_avatar_candidates_service_role_all" ON public.ad_avatar_candidates;

CREATE POLICY "ad_avatar_candidates_select_own_workspace" ON public.ad_avatar_candidates
  FOR SELECT
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

CREATE POLICY "ad_avatar_candidates_service_role_all" ON public.ad_avatar_candidates
  FOR ALL
  USING (auth.jwt()->>'role' = 'service_role')
  WITH CHECK (auth.jwt()->>'role' = 'service_role');
