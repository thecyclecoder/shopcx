-- body_locked_at flags reviews that an admin has hand-edited locally
-- (typo fix, profanity scrub, etc). The Klaviyo nightly sync should
-- update everything ELSE on the row (rating, status, smart_quote,
-- engagement counts) but leave body alone — otherwise our manual fix
-- gets steamrolled on the next sync.
--
-- Set automatically by any portal/dashboard UI that edits review
-- body. Cleared if the admin explicitly resets the lock.

ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS body_locked_at TIMESTAMPTZ;
