-- pre_renewal_reminders — the send-ledger for the pre-renewal reminder channel
-- ([[../../docs/brain/tables/pre_renewal_reminders]], spec: pre-renewal-reminder-sends Phase 1).
--
-- One row per (customer identity GROUP, renewal window). The daily cron
-- (src/lib/inngest/pre-renewal-reminders.ts) scans subscriptions renewing ~5 days
-- out across both live engines (billing_source 'shopcx' + 'internal'), collapses a
-- person's several/close-together renewals into ONE reminder via the
-- customer_links group_id, excludes paused/dunning/just-edited subs, asks the
-- subscriber-experiment harness for the arm, and writes a row here stamped with
-- that arm — holdout rows record the DECISION (no send), treatment rows record the
-- email + consented-SMS outcome. The UNIQUE (workspace_id, group_id,
-- renewal_window_key) is the idempotency guard: a re-run (or the same sub seen on
-- consecutive days while still in the window) can never double-send.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + drop-then-create policy (CLAUDE.md
-- idempotent-SQL-migration rail). Distinct from the charge crons
-- ([[../../docs/brain/inngest/internal-subscription-renewals]]).

CREATE TABLE IF NOT EXISTS public.pre_renewal_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- The customer_links group_id (or the customer's own id when unlinked) — the
  -- PERSON grain the experiment harness assigns on. Never a bare per-account id.
  group_id UUID NOT NULL,
  -- A representative account in the group (the earliest-renewing sub's customer),
  -- used for the email address / phone / journey session owner.
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  -- Dedupe key per renewal: the earliest in-window next_billing_date (YYYY-MM-DD)
  -- among the group's selected subs. Stable across daily re-scans of the window.
  renewal_window_key TEXT NOT NULL,
  next_billing_date DATE NOT NULL,
  -- The experiment arm this reminder decision was stamped with. 'holdout' rows get
  -- no send (the clean counterfactual); 'treatment' rows carry the send outcome.
  experiment_arm TEXT NOT NULL CHECK (experiment_arm IN ('treatment', 'holdout')),
  -- Channels actually attempted for this reminder (subset of ['email','sms']).
  channels TEXT[] NOT NULL DEFAULT '{}',
  -- Lifecycle: pending (treatment, mid-send) → sent; holdout; skipped (no arm/etc).
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'holdout', 'skipped')),
  -- The next-order journey the reminder links into.
  journey_session_id UUID REFERENCES public.journey_sessions(id) ON DELETE SET NULL,
  journey_token TEXT,
  -- Email channel outcome (Phase 2).
  email_status TEXT,            -- 'sent' | 'failed' | NULL (not attempted)
  email_sent_at TIMESTAMPTZ,
  email_error TEXT,
  -- SMS channel outcome + suppression accounting (Phase 3).
  sms_status TEXT,              -- 'sent' | 'scheduled' | 'suppressed_no_consent' | 'suppressed_stop' | 'failed' | NULL
  sms_suppression_reason TEXT,
  sms_resolved_timezone TEXT,
  sms_timezone_source TEXT,     -- customer_explicit | address_zip | phone_area_code | fallback
  sms_scheduled_send_at TIMESTAMPTZ,
  sms_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, group_id, renewal_window_key)
);

CREATE INDEX IF NOT EXISTS idx_pre_renewal_reminders_workspace
  ON public.pre_renewal_reminders (workspace_id, next_billing_date);
CREATE INDEX IF NOT EXISTS idx_pre_renewal_reminders_arm
  ON public.pre_renewal_reminders (workspace_id, experiment_arm);
CREATE INDEX IF NOT EXISTS idx_pre_renewal_reminders_customer
  ON public.pre_renewal_reminders (customer_id);

ALTER TABLE public.pre_renewal_reminders ENABLE ROW LEVEL SECURITY;

-- Service-role only: all writes go through createAdminClient() via the
-- src/lib/pre-renewal-reminders.ts chokepoint. No authenticated client read.
DROP POLICY IF EXISTS "Service role full access on pre_renewal_reminders" ON public.pre_renewal_reminders;
CREATE POLICY "Service role full access on pre_renewal_reminders"
  ON public.pre_renewal_reminders FOR ALL TO service_role USING (true) WITH CHECK (true);
