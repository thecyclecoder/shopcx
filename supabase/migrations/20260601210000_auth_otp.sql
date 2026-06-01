-- OTP login at checkout (Shop Pay-style). Customer enters email →
-- if it matches a profile with prior orders, we offer to send a
-- 6-digit code via SMS (to the phone ON FILE for that profile,
-- never the one typed into checkout) or email. Code verifies →
-- signed sx_session cookie → autofill name + addresses + saved
-- Braintree cards.
--
-- Twilio Verify is used for the SMS channel — Twilio handles code
-- generation, delivery, rate-limiting, brute-force protection. We
-- just track the Verify SID + outcome on our side for analytics +
-- the email fallback when Twilio reports a failed/undelivered SMS.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS twilio_verify_service_sid TEXT;

COMMENT ON COLUMN public.workspaces.twilio_verify_service_sid IS
  'Per-workspace Twilio Verify Service SID (VAxxxx). Provisioned once via the Settings → Integrations → Twilio "Setup OTP" button.';

CREATE TABLE IF NOT EXISTS public.auth_otp_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  -- Email is the IDENTITY — the customer must match by email; phone
  -- is just a delivery channel.
  email TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
  -- For SMS: masked phone we showed the customer ("•••89") so we can
  -- echo it in the resend / retry UI without leaking the full number.
  phone_masked TEXT,
  -- Twilio Verify's verification SID — used to cross-reference with
  -- the verification-check API on verify, and with the status webhook
  -- to detect delivery failure.
  twilio_verify_sid TEXT,
  -- Lifecycle status for analytics + email fallback decisions.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'verified', 'failed', 'expired')),
  -- Last Twilio delivery status we received via webhook.
  delivery_status TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  -- The cart this session is tied to (when present). Lets us
  -- short-circuit the lookup back to the cart on verify success.
  cart_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_otp_email_workspace ON public.auth_otp_sessions (workspace_id, email);
CREATE INDEX IF NOT EXISTS idx_auth_otp_verify_sid ON public.auth_otp_sessions (twilio_verify_sid) WHERE twilio_verify_sid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_auth_otp_cart_token ON public.auth_otp_sessions (cart_token) WHERE cart_token IS NOT NULL;
