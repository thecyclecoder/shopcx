-- subscription_cycle_charges.superseded_claims — audit trail of prior claim attempts on a
-- (subscription_id, cycle_key) row that were reclaimed by a later attempt.
--
-- Phase 1 of docs/brain/specs/a-declined-renewal-must-not-wedge-the-cycle-forever.md
-- (parent: retention "Subscription continuity & billing integrity" mandate).
--
-- Context: `claimCycleCharge` in src/lib/subscription-cycle-charge-claim.ts already lets a new
-- claimant atomically re-own a row whose prior claim was `status='failed'` (the ledger row is
-- flipped back to `in_flight` under the new claimant so the same cycle_key is chargeable again).
-- This phase extends that to a stale `in_flight` row (a crashed prior claim would wedge the
-- cycle exactly like a failed one), and — as the reset happens — appends a summary of the
-- prior attempt to `superseded_claims` so a repeatedly-declining subscription is visible as
-- such rather than silently overwritten. Ground truth: sub e4e3b82e held one row,
-- cycle_key=2026-10-04 status=failed claimed 2026-09-09, so every retry against the same
-- next_billing_date=2026-10-04 derived the same key and was refused.
--
-- Shape: a jsonb array, prepended (newest-first) on each reset. Each element is a snapshot:
--   { claimant, status, source, transaction_id, order_id, claimed_at, resolved_at, superseded_at }
-- so a query like `jsonb_array_length(superseded_claims) > N` surfaces subs whose current cycle
-- has been reclaimed many times. Kept on the row itself (rather than a separate history table)
-- because the audit is per-cycle-key and the row is already the natural per-cycle entity.
--
-- Idempotent: IF NOT EXISTS on the column + a NOT NULL DEFAULT so existing rows carry `[]`.
--
-- RLS unchanged (still deny-all outside the service role, per CLAUDE.md). All writes still go
-- through `createAdminClient()` in src/lib/subscription-cycle-charge-claim.ts.

ALTER TABLE public.subscription_cycle_charges
  ADD COLUMN IF NOT EXISTS superseded_claims jsonb NOT NULL DEFAULT '[]'::jsonb;
