-- Phase 4 of docs/brain/specs/checkout-stuck-defaults-to-assisted-purchase-concierge-sonnet-and-sol.md.
--
-- Re-activate the two assisted-purchase playbooks that shipped `is_active=true`
-- in supabase/migrations/20260707150000_seed_assisted_purchase_playbook.sql but
-- were manually deactivated in production after the OLD brittle signal matcher
-- (matchPlaybook / matchPlaybookScored in src/lib/playbook-executor.ts) over-fired
-- on broad trigger_intents (`buy`, `reorder`, `create_order`, `subscribe`),
-- starting the create-order / create-subscription playbook on any purchase-adjacent
-- language when Sol hadn't chosen it.
--
-- The Phase-4 code change makes these two playbooks SESSION-CHOSEN-ONLY (M4 of
-- sol-session-chosen-playbook-selection-retire-brittle-triggers) — the signal
-- matcher skips them via `isSessionChosenOnlyPlaybook(slug)` at the action point,
-- so re-enabling them here is safe: they only dispatch when Sol authors
-- `chosen_path='playbook'` + `plan.playbook_slug='assisted-order-purchase'` or
-- `'assisted-subscription-purchase'` on the live Direction, matching the assisted-
-- purchase blueprint (`src/lib/assisted-purchase-direction.ts`).
--
-- Idempotent: matches by slug (added in 20260708120000_playbooks_slug.sql) so
-- re-runs are a no-op after the flip. Compare-and-set on `is_active=false` per
-- learning #9 — the write's `.eq('is_active', false)` guard means an already-
-- active row is left alone rather than needlessly stamped `updated_at`.
--
-- Reversible: to disable a playbook, use the pre-existing admin path
-- (dashboard toggle) — this migration does not create the row, only flips the
-- flag. Downstream cheap-execution honors is_active=false immediately (both the
-- signal matcher and Sol's session-chosen dispatch check the flag).

UPDATE public.playbooks
SET is_active = true
WHERE slug IN (
  'assisted-order-purchase',
  'assisted-subscription-purchase'
)
AND is_active = false;
