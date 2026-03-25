-- Rules engine: workspace-scoped automation rules
CREATE TABLE public.rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  enabled BOOLEAN DEFAULT true,

  -- Trigger: which event type(s) activate this rule
  trigger_events TEXT[] NOT NULL,

  -- Conditions: compound AND/OR groups
  -- { "operator": "AND"|"OR", "groups": [{ "operator": "AND"|"OR", "conditions": [{ "field", "op", "value" }] }] }
  conditions JSONB NOT NULL DEFAULT '{"operator":"AND","groups":[]}',

  -- Actions: ordered list
  -- [{ "type": "add_tag"|"remove_tag"|"set_status"|"assign"|"auto_reply"|"internal_note"|"update_customer"|"appstle_action", "params": {...} }]
  actions JSONB NOT NULL DEFAULT '[]',

  -- Execution control
  priority INTEGER DEFAULT 0,
  stop_processing BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rules_workspace ON public.rules(workspace_id, enabled);

ALTER TABLE public.rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view rules in their workspaces"
  ON public.rules FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Service role full access on rules"
  ON public.rules FOR ALL
  USING (auth.role() = 'service_role');
