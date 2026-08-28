-- subscription_cycle_charges — per-(subscription, billing cycle) idempotency ledger for the
-- immediate-charge renewal chokepoint.
--
-- Phase 1 of docs/brain/specs/immediate-charge-renewal-paths-need-per-subscription-idempotency.md
-- (parent: retention "Subscription continuity & billing integrity" mandate).
--
-- Real evidence (2026-08-28): internal sub fd857ad9 (internal-a02696e2129c42a8) produced
-- SHOPCX273 at 17:18:44 and SHOPCX274 at 17:22:56 — both $102.33, both 2x Salted Caramel, both
-- source_name='internal_subscription_renewal', both type='renewal' + status='succeeded', SEPARATE
-- Braintree transactions (978p0vtf, 3cv2w8t8). The customer did not double-click. Two triggers
-- reached src/lib/inngest/internal-subscription-renewals.ts `internalSubscriptionRenewalAttempt`
-- 4.2 minutes apart and both charged.
--
-- The existing `isRenewalAttemptStale` guard deliberately exempts immediate-charge callers
-- (portal order-now, payment-method recovery, appstle orderNowByContract) because they send NO
-- `expected_next_billing_date` — that's on purpose (an immediate charge intentionally bypasses
-- the schedule). So nothing dedupes those callers today, and a second trigger for a cycle that's
-- already charging (or has already been charged in this cycle) both fires.
--
-- Guard shape: a claim row keyed on (subscription_id, cycle_key) — cycle_key is the sub's
-- pre-charge `next_billing_date` truncated to YYYY-MM-DD. The unique index refuses the second
-- INSERT at the database level; the src/lib/subscription-cycle-charge-claim.ts SDK detects the
-- 23505 conflict, reads the existing row, and turns it into a benign `refused_duplicate` skip
-- (never a raised error). Same as the ticket_directions live-row invariant (a partial UNIQUE
-- catches the race deterministically instead of relying on a retry).
--
-- Claim lifecycle:
--   status='in_flight'  — inserted BEFORE the Braintree sale. On conflict → refuse the second
--                          caller (either the first is still charging, or already succeeded).
--   status='succeeded'  — updated after the order + transaction row commit. A subsequent trigger
--                          for the same cycle_key is refused → no second charge.
--   status='failed'     — updated when Braintree declines. Dunning takes over from here and
--                          moves `next_billing_date` forward, so its retry naturally uses a NEW
--                          cycle_key and does NOT collide with this row.
--
-- `claimant` carries the Inngest event id (or a synthetic caller id) so a same-run retry that
-- re-INSERTs on top of its own prior partial insert is recognized as the same claim rather than
-- refused as a duplicate. Different claimants on the same key = the double-charge case.
--
-- All writes go through `createAdminClient()` from src/lib/subscription-cycle-charge-claim.ts.
-- RLS enabled + no policies = deny-all outside the service role. Per CLAUDE.md.

CREATE TABLE IF NOT EXISTS public.subscription_cycle_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  cycle_key text NOT NULL,
  status text NOT NULL DEFAULT 'in_flight' CHECK (status IN ('in_flight', 'succeeded', 'failed')),
  amount_cents integer,
  claimant text NOT NULL,
  source text,
  transaction_id uuid,
  order_id uuid,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- Per-cycle uniqueness — the whole point of the table. Two concurrent immediate-charge triggers
-- for one sub's current cycle race on the INSERT and exactly one wins.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_cycle_charges_sub_cycle_uidx
  ON public.subscription_cycle_charges (subscription_id, cycle_key);

-- Read-path: "recent claims for this sub" — dashboards / detectors scan by sub in reverse-time.
CREATE INDEX IF NOT EXISTS subscription_cycle_charges_sub_claimed_at_idx
  ON public.subscription_cycle_charges (subscription_id, claimed_at DESC);

-- Workspace-scoped scans (per-workspace guard audits, tenant-scoped cleanup).
CREATE INDEX IF NOT EXISTS subscription_cycle_charges_workspace_claimed_at_idx
  ON public.subscription_cycle_charges (workspace_id, claimed_at DESC);

ALTER TABLE public.subscription_cycle_charges ENABLE ROW LEVEL SECURITY;
