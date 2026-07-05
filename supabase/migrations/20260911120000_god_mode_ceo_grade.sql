-- god-mode CEO-grade approval model (docs/brain/lifecycles/god-mode.md follow-on).
--
-- Shifts god-mode from per-tool-call gating to "near-unlimited autonomy, escalate
-- only genuine CEO-grade DECISIONS in plain language." Three additive, idempotent
-- changes:
--   1) god_mode_approvals.category — the plain-language category a box-raised
--      DECISION card belongs to (e.g. 'ship-hotfix', 'submit-spec', 'dismiss-stale').
--      Keyed on by standing grants so "don't ask again about this type" works.
--   2) widen god_mode_approvals.risk CHECK to allow 'decision' — a box-initiated
--      plain-language CEO decision (distinct from the deterministic 'destructive'
--      PIN floor and the legacy 'plan'/'write' rows).
--   3) god_mode_standing_grants — the founder's "don't ask again" allowlist. One row
--      per (workspace, category) the founder has granted standing approval to; the
--      decision primitive auto-approves a category that appears here. The destructive
--      floor is NEVER standing-grantable (enforced app-side), so this can't be used
--      to silently grant catastrophic authority.

ALTER TABLE public.god_mode_approvals
  ADD COLUMN IF NOT EXISTS category text;

ALTER TABLE public.god_mode_approvals
  DROP CONSTRAINT IF EXISTS god_mode_approvals_risk_check;

ALTER TABLE public.god_mode_approvals
  ADD CONSTRAINT god_mode_approvals_risk_check
  CHECK (risk = ANY (ARRAY['safe'::text, 'write'::text, 'destructive'::text, 'plan'::text, 'decision'::text]));

CREATE TABLE IF NOT EXISTS public.god_mode_standing_grants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  category     text NOT NULL,
  granted_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, category)
);

CREATE INDEX IF NOT EXISTS god_mode_standing_grants_workspace_idx
  ON public.god_mode_standing_grants (workspace_id);

-- Service-role only (same posture as god_mode_sessions / god_mode_approvals — all
-- access flows through the SDK + admin client; no direct client reads/writes).
ALTER TABLE public.god_mode_standing_grants ENABLE ROW LEVEL SECURITY;
