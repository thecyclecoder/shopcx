-- ─────────────────────────────────────────────────────────────────
-- Smart popup + quiz (storefront-mvp Phase 4).
--
--   popup_decisions   one row per popup decision per session. Logs the
--                     variant + reason + who decided (rules vs Haiku) +
--                     the outcome funnel (shown → engaged → converted)
--                     from day one, so "smart" can be proven against a
--                     dumb timer and the Haiku prompt can be tuned.
--
-- Plus a quiz_answers column on storefront_leads (cups/day + health goal)
-- for segmentation / Klaviyo / personalization.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.popup_decisions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- Visitor binding — same anonymous_id pattern as sessions/events.
  anonymous_id  TEXT NOT NULL,
  session_id    UUID REFERENCES public.storefront_sessions(id) ON DELETE SET NULL,
  customer_id   UUID REFERENCES public.customers(id) ON DELETE SET NULL,

  -- 'discount' | 'quiz' | 'none' (none = candidacy passed but decider
  -- chose not to show, recorded so we can measure suppression too).
  variant       TEXT NOT NULL,
  reason        TEXT,
  -- 'rules' | 'haiku' — which decider produced this (for the A/B).
  decided_by    TEXT NOT NULL DEFAULT 'rules',

  -- The full computed offer stack (price discount + free shipping + gift,
  -- $ + effective %). Snapshotted so we can see what was promised.
  offer         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Outcome funnel — updated as the session progresses.
  shown         BOOLEAN NOT NULL DEFAULT false,
  engaged       BOOLEAN NOT NULL DEFAULT false,
  converted     BOOLEAN NOT NULL DEFAULT false,
  coupon_code   TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One decision per (workspace, session) — the candidacy gate caches the
  -- single per-session decision; subsequent outcome updates patch this row.
  CONSTRAINT popup_decisions_session_key UNIQUE (workspace_id, anonymous_id)
);

CREATE INDEX IF NOT EXISTS popup_decisions_workspace_created_idx
  ON public.popup_decisions (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS popup_decisions_customer_idx
  ON public.popup_decisions (customer_id) WHERE customer_id IS NOT NULL;

ALTER TABLE public.popup_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY popup_decisions_workspace_read ON public.popup_decisions
  FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY popup_decisions_service_all ON public.popup_decisions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Quiz answers on the lead (cups/day + health goal) for segmentation.
ALTER TABLE public.storefront_leads
  ADD COLUMN IF NOT EXISTS quiz_answers JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Stamp when the abandonment-fallback email went out, so a lead never
-- gets both the SMS and the fallback email.
ALTER TABLE public.storefront_leads
  ADD COLUMN IF NOT EXISTS fallback_emailed_at TIMESTAMPTZ;
