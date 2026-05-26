-- Policies table — single source of truth for customer-facing + AI-facing policy.
-- Replaces ~60 scattered sonnet_prompts entries that paraphrase the same rules
-- and addresses the drift problem that produced today's same-day-void incident
-- (a prompt rule contradicted another rule and nobody caught it).
--
-- Three consumers read from this table:
--   1. Orchestrator (`buildPreContext`) — emits `internal_summary` as a single
--      POLICIES: block, replacing dozens of overlapping prompts.
--   2. Playbook executor — reads structured `rules` JSONB for the deterministic
--      eligibility checks (no AI involvement on the binary "is this in-policy?"
--      decision).
--   3. Storefront `/policies/[slug]` page — renders `customer_summary` as
--      markdown so the public terms page mirrors what the AI is operating under.
--
-- versioning: each edit bumps `version`. Old versions are retained
-- (superseded_by points forward) so we can audit "this customer ordered
-- under v3 of refund policy" — relevant during disputes.

CREATE TABLE IF NOT EXISTS public.policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- Stable handle the orchestrator + storefront route on
  --   ('returns' | 'refunds' | 'subscriptions' | 'exchanges' | 'crisis')
  slug TEXT NOT NULL,
  name TEXT NOT NULL,

  -- Bumps on every edit. Active row is the highest-version row WHERE
  -- superseded_by IS NULL for a given (workspace, slug). Older versions
  -- stay queryable for audit.
  version INTEGER NOT NULL DEFAULT 1,
  effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_by UUID REFERENCES public.policies(id),

  -- Customer-facing — markdown. Renders to storefront /policies/{slug}.
  customer_summary TEXT NOT NULL,

  -- AI-facing — terser, includes operational detail (tier logic, thresholds,
  -- escalation triggers) that the customer-facing copy hides. Injected into
  -- orchestrator pre-context.
  internal_summary TEXT NOT NULL,

  -- Structured rules the playbook/code reads without invoking AI. Shape:
  --   [{ id, condition, action, exceptions?, notes? }, ...]
  rules JSONB NOT NULL DEFAULT '[]',

  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,  -- workspace_member who made the change

  UNIQUE (workspace_id, slug, version)
);

-- Lookup pattern: most reads are "give me the current active policy for
-- workspace X, slug Y" — single index covers it.
CREATE INDEX IF NOT EXISTS policies_active_lookup_idx
  ON public.policies (workspace_id, slug, version DESC)
  WHERE superseded_by IS NULL AND is_active = true;

ALTER TABLE public.policies ENABLE ROW LEVEL SECURITY;

-- RLS: authenticated users see policies for their workspace (read-only).
-- All writes go through service_role.
CREATE POLICY "policies_select_own_workspace" ON public.policies
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "policies_service_role_all" ON public.policies
  FOR ALL
  USING (auth.jwt()->>'role' = 'service_role')
  WITH CHECK (auth.jwt()->>'role' = 'service_role');

-- ── Playbook exceptions: skip_stand_firm column ────────────────────────────
-- Needed for the Tier 0 / "Loyalty Save" exception on the Refund playbook.
-- The existing playbook config has stand_firm_before_exceptions=2, meaning
-- every exception fires only after 2 rounds of policy denial. The loyalty
-- save is a fast-path — offered immediately on first contact when the
-- customer qualifies (renewal within 7d + 500+ points + no LOYALTY-* on the
-- order). This column lets that specific exception bypass the stand-firm
-- cadence without breaking the global setting.

ALTER TABLE public.playbook_exceptions
  ADD COLUMN IF NOT EXISTS skip_stand_firm BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.playbook_exceptions.skip_stand_firm IS
  'When true, this exception fires immediately on first eligible turn — no stand-firm cadence required first. Used for save-tactic exceptions like loyalty-redeem-as-partial-refund.';
