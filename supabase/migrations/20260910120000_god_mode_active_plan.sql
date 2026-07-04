-- god-mode plan-scoped approvals (hotfix, docs/brain/specs/god-mode.md follow-on).
--
-- Adds the "open plan" pointer + a new approval risk. A plan = ONE founder-approved
-- unit of work described in plain language; while it is open the box gate auto-allows
-- the non-destructive mechanical tool calls that implement it (destructive still
-- PIN-gates individually). So the founder approves the DECISION once instead of
-- rubber-stamping every keystroke.
--
-- Two additive changes, both idempotent:
--   1) god_mode_sessions.active_plan_id — FK to the approved plan row (NULL = no open
--      plan → per-call gating, the pre-hotfix behavior). ON DELETE SET NULL so a
--      cascade-deleted approval never dangles.
--   2) widen god_mode_approvals.risk CHECK to allow 'plan' (the plan card's risk;
--      never triggers the destructive PIN gate — only 'destructive' does).

ALTER TABLE public.god_mode_sessions
  ADD COLUMN IF NOT EXISTS active_plan_id uuid
  REFERENCES public.god_mode_approvals(id) ON DELETE SET NULL;

ALTER TABLE public.god_mode_approvals
  DROP CONSTRAINT IF EXISTS god_mode_approvals_risk_check;

ALTER TABLE public.god_mode_approvals
  ADD CONSTRAINT god_mode_approvals_risk_check
  CHECK (risk = ANY (ARRAY['safe'::text, 'write'::text, 'destructive'::text, 'plan'::text]));
