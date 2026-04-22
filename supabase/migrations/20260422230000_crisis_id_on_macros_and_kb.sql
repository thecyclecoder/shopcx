-- Add crisis_id to macros and knowledge_base for crisis-linked content
-- When crisis resolves, these can be deactivated/deleted

ALTER TABLE public.macros ADD COLUMN IF NOT EXISTS crisis_id UUID REFERENCES public.crisis_events(id) ON DELETE SET NULL;
ALTER TABLE public.knowledge_base ADD COLUMN IF NOT EXISTS crisis_id UUID REFERENCES public.crisis_events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_macros_crisis ON macros(crisis_id) WHERE crisis_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_crisis ON knowledge_base(crisis_id) WHERE crisis_id IS NOT NULL;
