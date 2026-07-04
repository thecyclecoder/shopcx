-- god-mode approval SMS: nudge-only, not per-approval spam.
--
-- The founder no longer wants a text on EVERY approval. Instead: text once only if
-- an approval has sat unanswered for 5+ minutes. This column marks when that nudge
-- fired so the 60s sweep (nudgeStalePendingApprovals in src/lib/god-mode.ts) never
-- double-texts the same pending row. NULL = not yet nudged.
ALTER TABLE public.god_mode_approvals
  ADD COLUMN IF NOT EXISTS sms_notified_at timestamptz;
