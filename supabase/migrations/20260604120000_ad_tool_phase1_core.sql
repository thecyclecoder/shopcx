-- Ad tool — Phase 1: Higgsfield integration core schema.
--
-- Four tables (avatars -> campaigns -> videos, with ad_jobs tracking every
-- async Higgsfield call) plus per-workspace encrypted Higgsfield credentials.
-- All RLS-scoped to workspace, service-role write. See
-- docs/brain/specs/ad-tool.md Phase 1.

-- ── ad_avatars — per-workspace persistent Higgsfield characters ─────────────
CREATE TABLE IF NOT EXISTS public.ad_avatars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                         -- admin-facing
  higgsfield_character_id TEXT,               -- returned by create_character
  reference_image_urls TEXT[] NOT NULL DEFAULT '{}',  -- photos we trained on
  created_by UUID,                            -- workspace_members.user_id
  status TEXT NOT NULL DEFAULT 'active',       -- active | archived
  cost_cents INTEGER NOT NULL DEFAULT 0,       -- character creation cost
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ad_avatars_workspace_idx
  ON public.ad_avatars (workspace_id, status, created_at DESC);

-- ── ad_campaigns — one row per ad concept (script + product + avatar) ───────
CREATE TABLE IF NOT EXISTS public.ad_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  avatar_id UUID REFERENCES public.ad_avatars(id) ON DELETE SET NULL,
  variant_id UUID REFERENCES public.product_variants(id) ON DELETE SET NULL,
  angle_id UUID REFERENCES public.product_ad_angles(id) ON DELETE SET NULL,

  script_text TEXT,                            -- full script: hook / body / CTA
  length_sec INTEGER NOT NULL DEFAULT 15,      -- 15 | 30
  voice_id TEXT,                               -- TTS voice id (Higgsfield/ElevenLabs)
  caption_style TEXT NOT NULL DEFAULT 'hormozi_yellow',
  vibe_tags TEXT[] NOT NULL DEFAULT '{}',

  hero_image_url TEXT,                          -- Supabase Storage URL (Soul output)
  audio_url TEXT,                               -- TTS output

  status TEXT NOT NULL DEFAULT 'draft',         -- draft | rendering | ready | failed
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ad_campaigns_workspace_idx
  ON public.ad_campaigns (workspace_id, created_at DESC);

-- ── ad_videos — one row per rendered output (per format) ────────────────────
CREATE TABLE IF NOT EXISTS public.ad_videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES public.ad_campaigns(id) ON DELETE CASCADE,

  -- One ad renders into 4 sibling rows (Reels MP4 / Feed-4:5 MP4 / Stories JPG /
  -- Feed-4:5 JPG). Siblings link to the canonical row via format_variant_of_id.
  format TEXT NOT NULL DEFAULT 'reels_9x16',   -- reels_9x16 | feed_4x5 | stories_9x16
  media_kind TEXT NOT NULL DEFAULT 'video',    -- video | static
  format_variant_of_id UUID REFERENCES public.ad_videos(id) ON DELETE SET NULL,

  final_mp4_url TEXT,                           -- final video output
  static_jpg_url TEXT,                          -- frame extract (thumbnail purposes)
  -- Dedicated static-ad compositions (NOT frame grabs):
  -- [{ template_slug, image_url, format }]
  static_variants JSONB NOT NULL DEFAULT '[]',

  talking_head_url TEXT,                        -- single Speak output
  talking_head_segments_url TEXT[],            -- multi-clip (30s ads)
  audio_url TEXT,
  -- [{ image_url, video_url, prompt, motion_id }]
  b_roll_urls JSONB NOT NULL DEFAULT '[]',
  transcript_json JSONB,                        -- Whisper word-level timestamps

  caption_style TEXT NOT NULL DEFAULT 'hormozi_yellow',
  duration_sec INTEGER,
  cost_cents INTEGER NOT NULL DEFAULT 0,        -- credits + Whisper + TTS
  meta JSONB NOT NULL DEFAULT '{}',             -- job_set_ids, attempts, errors

  status TEXT NOT NULL DEFAULT 'pending',       -- pending | rendering | ready | failed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ad_videos_campaign_idx
  ON public.ad_videos (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ad_videos_workspace_idx
  ON public.ad_videos (workspace_id, status, created_at DESC);

-- ── ad_jobs — Higgsfield async job tracking (audit + replay) ────────────────
CREATE TABLE IF NOT EXISTS public.ad_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES public.ad_campaigns(id) ON DELETE CASCADE,
  video_id UUID REFERENCES public.ad_videos(id) ON DELETE SET NULL,

  -- create_character | soul_image | dop_video | speak_video | tts_audio | whisper
  job_type TEXT NOT NULL,
  higgsfield_job_set_id TEXT,
  -- queued | in_progress | completed | failed | nsfw
  status TEXT NOT NULL DEFAULT 'queued',
  request_payload JSONB,
  response_payload JSONB,
  output_url TEXT,
  cost_credits INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  polled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ad_jobs_workspace_idx
  ON public.ad_jobs (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ad_jobs_jobset_idx
  ON public.ad_jobs (higgsfield_job_set_id);

-- ── RLS — read for workspace members, all writes via service_role ───────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ad_avatars','ad_campaigns','ad_videos','ad_jobs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_select_own_workspace" ON public.%1$I', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_service_role_all" ON public.%1$I', t);
    EXECUTE format($f$
      CREATE POLICY "%1$s_select_own_workspace" ON public.%1$I
        FOR SELECT USING (
          workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
        )$f$, t);
    EXECUTE format($f$
      CREATE POLICY "%1$s_service_role_all" ON public.%1$I
        FOR ALL USING (auth.jwt()->>'role' = 'service_role')
        WITH CHECK (auth.jwt()->>'role' = 'service_role')$f$, t);
  END LOOP;
END $$;

-- ── workspaces — ad tool config + encrypted Higgsfield credentials ──────────
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS higgsfield_api_key_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS higgsfield_secret_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS ad_tool_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_avatar_id UUID REFERENCES public.ad_avatars(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_caption_style TEXT NOT NULL DEFAULT 'hormozi_yellow',
  -- Phase 0.5 settings (per-workspace ad-tool config).
  ADD COLUMN IF NOT EXISTS ad_tool_settings JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.workspaces.ad_tool_settings IS
  'Ad-tool per-workspace settings: { banned_words[], lf8_allowed[], ugly_intensity, default_urgency_by_category{}, pinned_badges[], cost_cap_cents }. See /dashboard/settings/ad-tool.';
