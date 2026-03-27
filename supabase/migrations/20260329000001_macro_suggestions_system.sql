-- AI-Suggested Macro System: usage logging, notifications, suggestion tracking

-- 1. New columns on macros for suggestion tracking
ALTER TABLE public.macros ADD COLUMN IF NOT EXISTS ai_suggest_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.macros ADD COLUMN IF NOT EXISTS ai_accept_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.macros ADD COLUMN IF NOT EXISTS ai_reject_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.macros ADD COLUMN IF NOT EXISTS ai_edit_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.macros ADD COLUMN IF NOT EXISTS last_suggested_at TIMESTAMPTZ;

-- 2. Macro usage log (detailed per-use tracking)
CREATE TABLE public.macro_usage_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  macro_id UUID NOT NULL REFERENCES public.macros(id) ON DELETE CASCADE,
  ticket_id UUID REFERENCES public.tickets(id) ON DELETE SET NULL,
  message_id UUID REFERENCES public.ticket_messages(id) ON DELETE SET NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'ai_suggested', 'ai_auto', 'search')),
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'personalized', 'edited', 'rejected', 'auto_sent')),
  ai_confidence FLOAT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_macro_usage_log_workspace ON public.macro_usage_log(workspace_id, created_at DESC);
CREATE INDEX idx_macro_usage_log_macro ON public.macro_usage_log(macro_id, created_at DESC);

ALTER TABLE public.macro_usage_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view macro usage in their workspace" ON public.macro_usage_log FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full access on macro_usage_log" ON public.macro_usage_log FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. Dashboard notifications (generic, reusable across features)
CREATE TABLE public.dashboard_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('macro_suggestion', 'pattern_review', 'knowledge_gap', 'system')),
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  metadata JSONB DEFAULT '{}',
  read BOOLEAN NOT NULL DEFAULT false,
  dismissed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dashboard_notifications_user ON public.dashboard_notifications(workspace_id, user_id, read, dismissed);
CREATE INDEX idx_dashboard_notifications_type ON public.dashboard_notifications(workspace_id, type, created_at DESC);

ALTER TABLE public.dashboard_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their notifications" ON public.dashboard_notifications FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
    AND (user_id IS NULL OR user_id = auth.uid())
  );
CREATE POLICY "Users can update their notifications" ON public.dashboard_notifications FOR UPDATE TO authenticated
  USING (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
    AND (user_id IS NULL OR user_id = auth.uid())
  )
  WITH CHECK (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
    AND (user_id IS NULL OR user_id = auth.uid())
  );
CREATE POLICY "Service role full access on dashboard_notifications" ON public.dashboard_notifications FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4. RPC to increment suggestion tracking on macros
CREATE OR REPLACE FUNCTION public.record_macro_suggestion_outcome(
  p_macro_id UUID,
  p_outcome TEXT
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_outcome = 'suggested' THEN
    UPDATE public.macros SET ai_suggest_count = ai_suggest_count + 1, last_suggested_at = now() WHERE id = p_macro_id;
  ELSIF p_outcome = 'accepted' THEN
    UPDATE public.macros SET ai_accept_count = ai_accept_count + 1 WHERE id = p_macro_id;
  ELSIF p_outcome = 'rejected' THEN
    UPDATE public.macros SET ai_reject_count = ai_reject_count + 1 WHERE id = p_macro_id;
  ELSIF p_outcome = 'edited' THEN
    UPDATE public.macros SET ai_edit_count = ai_edit_count + 1 WHERE id = p_macro_id;
  END IF;
END;
$$;
