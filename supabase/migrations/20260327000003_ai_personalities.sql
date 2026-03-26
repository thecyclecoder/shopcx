-- Phase 4: AI Personalities and Channel Configuration

-- AI Personalities (reusable across channels)
CREATE TABLE public.ai_personalities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  tone TEXT NOT NULL DEFAULT 'friendly',
  style_instructions TEXT NOT NULL DEFAULT '',
  sign_off TEXT,
  greeting TEXT,
  emoji_usage TEXT NOT NULL DEFAULT 'minimal' CHECK (emoji_usage IN ('none', 'minimal', 'moderate', 'heavy')),
  language TEXT NOT NULL DEFAULT 'en',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_personalities_workspace ON public.ai_personalities(workspace_id);

ALTER TABLE public.ai_personalities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view AI personalities" ON public.ai_personalities FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full access on AI personalities" ON public.ai_personalities FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Per-channel AI configuration
CREATE TABLE public.ai_channel_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'chat', 'sms', 'meta_dm', 'phone')),
  personality_id UUID REFERENCES public.ai_personalities(id) ON DELETE SET NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  sandbox BOOLEAN NOT NULL DEFAULT true,
  instructions TEXT NOT NULL DEFAULT '',
  max_response_length INTEGER,
  confidence_threshold FLOAT NOT NULL DEFAULT 0.95,
  auto_resolve BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, channel)
);

CREATE INDEX idx_ai_channel_config_workspace ON public.ai_channel_config(workspace_id);

ALTER TABLE public.ai_channel_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view AI channel config" ON public.ai_channel_config FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full access on AI channel config" ON public.ai_channel_config FOR ALL TO service_role USING (true) WITH CHECK (true);
