-- Track macro usage on ticket messages + AI confidence history

-- Add macro reference to ticket messages
ALTER TABLE public.ticket_messages ADD COLUMN IF NOT EXISTS macro_id UUID REFERENCES public.macros(id) ON DELETE SET NULL;
ALTER TABLE public.ticket_messages ADD COLUMN IF NOT EXISTS ai_personalized BOOLEAN DEFAULT false;

-- AI confidence + suggested macro on tickets (in addition to existing ai_ fields)
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS ai_suggested_macro_id UUID REFERENCES public.macros(id) ON DELETE SET NULL;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS ai_suggested_macro_name TEXT;

-- Update default confidence threshold to 90%
ALTER TABLE public.ai_channel_config ALTER COLUMN confidence_threshold SET DEFAULT 0.90;

-- Index for macro usage analytics
CREATE INDEX IF NOT EXISTS idx_ticket_messages_macro ON public.ticket_messages(macro_id) WHERE macro_id IS NOT NULL;

-- Most-used macros view helper
CREATE OR REPLACE FUNCTION public.macro_usage_stats(ws_id UUID, days INT DEFAULT 30)
RETURNS TABLE(macro_id UUID, macro_name TEXT, use_count BIGINT)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.name, COUNT(tm.id) AS use_count
  FROM public.macros m
  LEFT JOIN public.ticket_messages tm ON tm.macro_id = m.id
    AND tm.created_at > now() - (days || ' days')::interval
  WHERE m.workspace_id = ws_id AND m.active = true
  GROUP BY m.id, m.name
  ORDER BY use_count DESC, m.usage_count DESC
  LIMIT 20;
END;
$$;
