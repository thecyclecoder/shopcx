-- Allow journey_sessions.status = 'processing'.
--
-- The review-journey single-use claim (Fix 1 of review-collection-foundations,
-- added by the security review) does a compare-and-set from
-- ['pending','in_progress'] → 'processing' before any side effect, so two
-- concurrent submits on one token cannot both write a review and mint a reward.
--
-- But 'processing' was never in journey_sessions_status_check, which allows
-- only pending / in_progress / completed / expired / abandoned. So the claim
-- UPDATE was rejected by the constraint on EVERY submit, returned zero rows,
-- and the handler read zero rows as "already claimed" and answered 409. The
-- guard against double-submission was preventing ALL submission — no review
-- could ever be written through the journey.
--
-- Adding the status rather than reusing 'in_progress' as the marker: the CAS
-- reads FROM ['pending','in_progress'], so claiming INTO 'in_progress' would
-- make an already-claimed session claimable again and reintroduce exactly the
-- race Fix 1 closed.
--
-- Widening a CHECK constraint. No data touched, no column dropped.
-- -- reversible: widens the allowed set; every existing row stays valid

ALTER TABLE public.journey_sessions
  DROP CONSTRAINT IF EXISTS journey_sessions_status_check;

ALTER TABLE public.journey_sessions
  ADD CONSTRAINT journey_sessions_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text,
    'in_progress'::text,
    'processing'::text,
    'completed'::text,
    'expired'::text,
    'abandoned'::text
  ]));
