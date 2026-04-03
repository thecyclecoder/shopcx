-- Playbook system: structured decision trees for complex customer issues

-- ── Playbooks ──
CREATE TABLE IF NOT EXISTS public.playbooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  trigger_intents TEXT[] NOT NULL DEFAULT '{}',
  trigger_patterns TEXT[] NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  exception_limit INTEGER NOT NULL DEFAULT 1,
  stand_firm_max INTEGER NOT NULL DEFAULT 3,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.playbooks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read playbooks" ON public.playbooks FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full access on playbooks" ON public.playbooks FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Policies ──
CREATE TABLE IF NOT EXISTS public.playbook_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  playbook_id UUID NOT NULL REFERENCES public.playbooks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  conditions JSONB NOT NULL DEFAULT '{}',
  ai_talking_points TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.playbook_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read playbook_policies" ON public.playbook_policies FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full on playbook_policies" ON public.playbook_policies FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Exceptions ──
CREATE TABLE IF NOT EXISTS public.playbook_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  playbook_id UUID NOT NULL REFERENCES public.playbooks(id) ON DELETE CASCADE,
  policy_id UUID NOT NULL REFERENCES public.playbook_policies(id) ON DELETE CASCADE,
  tier INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  conditions JSONB NOT NULL DEFAULT '{}',
  resolution_type TEXT NOT NULL CHECK (resolution_type IN ('store_credit_return', 'refund_return', 'store_credit_no_return', 'refund_no_return')),
  instructions TEXT,
  auto_grant BOOLEAN NOT NULL DEFAULT false,
  auto_grant_trigger TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.playbook_exceptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read playbook_exceptions" ON public.playbook_exceptions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full on playbook_exceptions" ON public.playbook_exceptions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Steps ──
CREATE TABLE IF NOT EXISTS public.playbook_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  playbook_id UUID NOT NULL REFERENCES public.playbooks(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL CHECK (type IN (
    'identify_order', 'identify_subscription', 'check_other_subscriptions',
    'apply_policy', 'offer_exception', 'initiate_return',
    'explain', 'stand_firm', 'cancel_subscription',
    'issue_store_credit', 'custom'
  )),
  name TEXT NOT NULL,
  instructions TEXT,
  data_access TEXT[] NOT NULL DEFAULT '{}',
  resolved_condition TEXT,
  config JSONB NOT NULL DEFAULT '{}',
  skippable BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.playbook_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read playbook_steps" ON public.playbook_steps FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full on playbook_steps" ON public.playbook_steps FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS idx_playbooks_workspace ON public.playbooks (workspace_id, is_active, priority DESC);
CREATE INDEX IF NOT EXISTS idx_playbook_steps_order ON public.playbook_steps (playbook_id, step_order);
CREATE INDEX IF NOT EXISTS idx_playbook_exceptions_tier ON public.playbook_exceptions (playbook_id, policy_id, tier);

-- ── Ticket fields for playbook state ──
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS active_playbook_id UUID REFERENCES public.playbooks(id);
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS playbook_step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS playbook_queue JSONB NOT NULL DEFAULT '[]';
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS playbook_context JSONB NOT NULL DEFAULT '{}';
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS playbook_exceptions_used INTEGER NOT NULL DEFAULT 0;

-- ── Escalation gaps table (for when nothing matches) ──
CREATE TABLE IF NOT EXISTS public.escalation_gaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ticket_id UUID REFERENCES public.tickets(id),
  intent TEXT,
  confidence INTEGER,
  message_excerpt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.escalation_gaps ENABLE ROW LEVEL SECURITY;
-- Policy may already exist from unified handler migration
DO $$ BEGIN
  CREATE POLICY "Service role full on escalation_gaps" ON public.escalation_gaps FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
