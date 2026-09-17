-- orders gains an allergen hold state — the flag that stops an unshipped order the moment
-- an allergy/safety escalation is raised against the customer.
--
-- WHY. Ground truth: order SC138523 was placed 2026-09-13T02:29, the customer emailed at
-- 02:33 that she was allergic to hazelnuts, the warehouse received the order at 05:30
-- (three hours AFTER the allergy report), and it shipped 2026-09-15T00:52 — a 46-hour
-- window nobody used. The remedy had a deadline and the process had none; the agent
-- told her twice on the ticket "we're stopping the parcel" and nothing stopped it
-- because holding depended on a human noticing in time. Once an allergen ships the
-- only remedy left is money. This column records the reversible protective action
-- (stop the parcel) separately from the judgement call (what remedy for the customer,
-- which stays with a human via the existing allergy override in the exchanges policy).
--
-- SHAPE.
--   hold_status         'placed' | 'refused' | null
--   hold_kind           categorical reason for the hold ('allergen' for Phase 1)
--   hold_reason         free-text reason as raised (mirrors escalation_reason)
--   hold_ticket_id      the ticket that triggered the hold (→ tickets.id)
--   hold_placed_at      when the hold was raised (both placed AND refused paths stamp this)
--   hold_refused_reason free-text — populated ONLY when hold_status='refused' (already
--                       shipped, already picked, already manifested). The moment the
--                       remedy space collapses to a refund — the person handling the
--                       ticket needs to see this.
--
-- Distinguishing the three states matters (spec Phase 2 surface):
--   hold_status='placed'                     — hold was raised, parcel should not ship
--   hold_status='refused'                    — hold was ATTEMPTED, warehouse could not
--                                              honor it (already shipped / no update path)
--   hold_status IS NULL                      — no hold was ever attempted on this order
-- Today all three look identical on the ticket, which is how "we're stopping it" got
-- said about an order with no hold.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS hold_status text,
  ADD COLUMN IF NOT EXISTS hold_kind text,
  ADD COLUMN IF NOT EXISTS hold_reason text,
  ADD COLUMN IF NOT EXISTS hold_ticket_id uuid,
  ADD COLUMN IF NOT EXISTS hold_placed_at timestamptz,
  ADD COLUMN IF NOT EXISTS hold_refused_reason text;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_hold_status_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_hold_status_check
      CHECK (hold_status IS NULL OR hold_status IN ('placed', 'refused'));
  END IF;
END $$;

-- Partial index: the reconcile-sweep guard needs to answer "is this workspace_id + order held?"
-- cheaply, and only 'placed' rows matter (a 'refused' hold is a dead-letter — the parcel
-- already left). Same shape as the fraud-hold guard's join.
CREATE INDEX IF NOT EXISTS orders_hold_status_placed_idx
  ON public.orders (workspace_id, id)
  WHERE hold_status = 'placed';

COMMENT ON COLUMN public.orders.hold_status IS
  'Allergen/safety hold state on an unshipped order. ''placed'' means the hold was raised and the parcel should not ship; ''refused'' means the hold was attempted but the warehouse could not honor it (already shipped / picked / manifested); NULL means no hold has ever been attempted. All three MUST be distinguishable on the ticket surface (spec: a-flagged-allergen-order-must-not-ship, Phase 2) — a refused/absent hold on a live allergy ticket is an alert, not a field.';

COMMENT ON COLUMN public.orders.hold_kind IS
  'Categorical reason the hold was raised. Phase 1 ships ''allergen'' only; other kinds may follow. Never a free-form string — bounded so the reconcile-sweep guard + ticket surface can key on it deterministically.';

COMMENT ON COLUMN public.orders.hold_reason IS
  'Free-text reason as raised — mirrors the ticket''s escalation_reason at the moment the hold was placed. Human-readable audit trail.';

COMMENT ON COLUMN public.orders.hold_ticket_id IS
  'The ticket whose escalation triggered the hold. Not a FK — a ticket delete cascade dropping the hold trail would erase the audit trail on the order.';

COMMENT ON COLUMN public.orders.hold_placed_at IS
  'When the hold was attempted. Stamped on BOTH the placed and refused paths — the attempt is what matters, not just the success.';

COMMENT ON COLUMN public.orders.hold_refused_reason IS
  'Set when hold_status=''refused'' — describes why the warehouse could not honor the hold (''already_shipped'' is the archetype). NULL on the placed path. The moment the remedy space collapses to a refund and the ticket handler needs to know.';
