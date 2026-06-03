-- Ad tool — Creative library: durable per-piece persistence + stitch recipe.
--
-- Before this, the intermediate clips a render produced (each talking-head Veo
-- segment, each b-roll clip, the music bed) were uploaded to storage but never
-- recorded in the DB — orphaned, unfindable by campaign, and with no record of
-- WHICH script generated WHICH ~8s segment. That made the core re-launch flow
-- impossible: "this ad is fatiguing, refresh the hook, redo ONE segment and
-- re-stitch" needs every piece + the assembly recipe retained.
--
-- ad_segments  = the creative library (one row per generated piece + its inputs).
-- ad_campaigns.composition = the stitch recipe (ordered segment refs + mix).
-- See docs/brain/tables/ad_segments.md + docs/brain/lifecycles/ad-render.md.

-- ── ad_segments — every generated piece, with what made it ──────────────────
CREATE TABLE IF NOT EXISTS public.ad_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES public.ad_campaigns(id) ON DELETE CASCADE,

  kind TEXT NOT NULL,                 -- talking_head | broll | music
  seq INTEGER NOT NULL DEFAULT 0,     -- order within its kind / timeline position

  -- Versioning for partial refresh: regenerating one segment inserts a NEW row
  -- with version+1, flips the old row's is_active=false. The active row at each
  -- (campaign, kind, seq) is the one in the current cut.
  version INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,

  -- The exact generation inputs — so a piece can be reproduced or re-prompted.
  script_text TEXT,                   -- talking_head: the exact words spoken in this clip
  prompt TEXT,                        -- full generation prompt sent to the model
  model TEXT,                         -- veo-3.1-fast-generate-preview | dop:<motion> | lyria-3 …

  storage_path TEXT,                  -- private ad-tool bucket path (no signed URL stored)
  duration_sec NUMERIC,               -- raw clip length as generated
  trim_sec NUMERIC,                   -- trimmed length used in the stitch (last-word + pad)
  transcript_json JSONB,              -- talking_head: per-segment Whisper word timings

  status TEXT NOT NULL DEFAULT 'generating',  -- generating | ready | failed
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ad_segments_campaign_idx
  ON public.ad_segments (campaign_id, kind, seq, version DESC);
CREATE INDEX IF NOT EXISTS ad_segments_active_idx
  ON public.ad_segments (campaign_id) WHERE is_active;

-- ── ad_campaigns.composition — the stitch recipe render reads ───────────────
-- {
--   segments: [{ segment_id, startSec, trimSec }],      -- base VO talking layer, in order
--   broll:    [{ segment_id, fromSec, durSec, volume }], -- muted/ASMR overlays
--   music:    { segment_id, volume } | null,             -- one low bed
--   durationSec, fps
-- }
-- Render writes it; re-stitch swaps a segment_id + re-renders. Format-agnostic
-- (the canonical 9:16 timeline; other formats reframe via safe-zone).
ALTER TABLE public.ad_campaigns
  ADD COLUMN IF NOT EXISTS composition JSONB;

COMMENT ON COLUMN public.ad_campaigns.composition IS
  'Stitch recipe: ordered ad_segments refs + b-roll overlays + music mix. Render reads it; partial-refresh swaps one segment_id and re-renders. See docs/brain/lifecycles/ad-render.md.';

-- ── RLS — read for workspace members, all writes via service_role ───────────
DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.ad_segments ENABLE ROW LEVEL SECURITY';
  DROP POLICY IF EXISTS "ad_segments_select_own_workspace" ON public.ad_segments;
  DROP POLICY IF EXISTS "ad_segments_service_role_all" ON public.ad_segments;
  EXECUTE $f$
    CREATE POLICY "ad_segments_select_own_workspace" ON public.ad_segments
      FOR SELECT USING (
        workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
      )$f$;
  EXECUTE $f$
    CREATE POLICY "ad_segments_service_role_all" ON public.ad_segments
      FOR ALL USING (auth.jwt()->>'role' = 'service_role')
      WITH CHECK (auth.jwt()->>'role' = 'service_role')$f$;
END $$;
