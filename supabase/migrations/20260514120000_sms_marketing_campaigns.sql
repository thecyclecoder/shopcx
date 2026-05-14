-- ─────────────────────────────────────────────────────────────────
-- SMS/MMS marketing campaigns. First slice — campaigns + recipients.
-- Shortlinks, coupon templates, and the AI scheduler come in
-- follow-up migrations.
--
-- The core design constraint: every recipient is sent at the right
-- local hour in THEIR timezone, not ours. The orchestrator resolves
-- each recipient's timezone at enqueue time and stamps the UTC
-- instant of delivery on the recipient row, so the cron worker just
-- picks rows whose scheduled_send_at <= now() and dispatches them.
-- See STOREFRONT.md / src/lib/marketing-text-timezone.ts for the
-- timezone priority chain.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sms_campaigns (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  name                TEXT NOT NULL,

  -- 'draft' | 'scheduled' | 'sending' | 'sent' | 'paused' | 'cancelled'
  --   draft        — admin still editing, no recipients resolved
  --   scheduled    — admin clicked Schedule, recipient queue being built
  --                  (or already built); send-tick will fire rows as they
  --                  hit their scheduled_send_at
  --   sending      — orchestrator picked it up, send-tick actively
  --                  draining the queue
  --   sent         — all recipients have a terminal status
  --   paused       — admin paused mid-send; remaining pending rows skip
  --   cancelled    — admin cancelled before any send; queue is dropped
  status              TEXT NOT NULL DEFAULT 'draft',

  -- The text body. Up to ~1600 chars (Twilio caps at 10 SMS segments).
  -- Shortcode senders are usually capped lower by carrier policy.
  message_body        TEXT NOT NULL,

  -- Optional MMS image. Public URL fetchable by Twilio at send time
  -- (we store our own uploads in workspace-scoped storage; the URL
  -- in this column is the public-readable path). Null = SMS-only.
  media_url           TEXT,

  -- Send timing:
  --   send_date         — the LOCAL calendar date in each recipient's TZ
  --                       when they should receive the message
  --   target_local_hour — 0-23, local-time hour we aim for
  --   fallback_timezone — IANA name used when we can't derive a
  --                       recipient's timezone (no customer record,
  --                       no address, no phone area code we can parse)
  send_date           DATE NOT NULL,
  target_local_hour   INTEGER NOT NULL DEFAULT 11
    CHECK (target_local_hour BETWEEN 0 AND 23),
  fallback_timezone   TEXT NOT NULL DEFAULT 'America/Chicago',

  -- Audience selection — JSONB filter spec. Resolved at Schedule
  -- time into concrete sms_campaign_recipients rows. Shape evolves:
  --   v1: { marketing_status: 'subscribed',
  --         subscription_status: ['active','paused'],
  --         min_orders?: number, ... }
  audience_filter     JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Stats cache, updated as recipients flip status. Lets the list
  -- view stay fast without aggregating every row.
  recipients_total    INTEGER NOT NULL DEFAULT 0,
  recipients_sent     INTEGER NOT NULL DEFAULT 0,
  recipients_failed   INTEGER NOT NULL DEFAULT 0,
  recipients_skipped  INTEGER NOT NULL DEFAULT 0,

  -- Lifecycle timestamps
  scheduled_at        TIMESTAMPTZ,           -- when admin scheduled
  first_send_at       TIMESTAMPTZ,           -- first recipient send
  last_send_at        TIMESTAMPTZ,           -- last recipient send
  completed_at        TIMESTAMPTZ,

  created_by          UUID,                  -- workspace_member user
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sms_campaigns_workspace_status_idx
  ON public.sms_campaigns (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS sms_campaigns_status_idx
  ON public.sms_campaigns (status) WHERE status IN ('scheduled', 'sending');


CREATE TABLE IF NOT EXISTS public.sms_campaign_recipients (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL,                              -- denorm for fast filtering
  campaign_id         UUID NOT NULL REFERENCES public.sms_campaigns(id) ON DELETE CASCADE,
  customer_id         UUID REFERENCES public.customers(id) ON DELETE SET NULL,

  -- E.164 phone the message will land at. Set at enqueue time from
  -- customers.phone; held here so a later phone change on the
  -- customer doesn't reroute an already-queued send.
  phone               TEXT NOT NULL,

  -- Timezone resolution at enqueue time. resolved_timezone is the
  -- IANA name actually used to compute scheduled_send_at;
  -- timezone_source records which path the resolver took, so we can
  -- audit "where do unknown TZs come from."
  resolved_timezone   TEXT NOT NULL,
  timezone_source     TEXT NOT NULL,
    -- 'customer_explicit' | 'address_zip' | 'phone_area_code' | 'fallback'

  -- The UTC instant the cron will fire this send. Pre-computed so
  -- the send-tick query is a single index scan, no per-row math.
  scheduled_send_at   TIMESTAMPTZ NOT NULL,

  -- Lifecycle:
  --   pending        — waiting for scheduled_send_at
  --   sending        — handed to Twilio
  --   sent           — Twilio accepted (queued for delivery)
  --   delivered      — Twilio confirmed delivery (via status webhook)
  --   failed         — Twilio rejected (4xx/5xx)
  --   opted_out      — customer is on the opt-out list
  --   invalid_phone  — number can't be normalized to E.164
  --   skipped        — campaign paused/cancelled before this row sent
  status              TEXT NOT NULL DEFAULT 'pending',
  message_sid         TEXT,                 -- Twilio message SID once sent
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  error               TEXT,

  -- Per-recipient shortlink slug (filled when a campaign embeds a
  -- shortlink; null otherwise). Same column will be used by the
  -- shortlink redirect handler to attribute clicks back to a specific
  -- send. Foreign key drops here once sms_shortlinks ships.
  shortlink_slug      TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One recipient row per (campaign, phone). Prevents accidental
  -- double-sends if an audience filter resolves the same phone via
  -- two linked customer profiles.
  CONSTRAINT sms_campaign_recipients_campaign_phone_key
    UNIQUE (campaign_id, phone)
);

-- The hot index — the send-tick cron picks pending rows whose
-- scheduled_send_at has passed. Partial index keeps it small.
CREATE INDEX IF NOT EXISTS sms_campaign_recipients_pending_idx
  ON public.sms_campaign_recipients (scheduled_send_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS sms_campaign_recipients_campaign_status_idx
  ON public.sms_campaign_recipients (campaign_id, status);
CREATE INDEX IF NOT EXISTS sms_campaign_recipients_workspace_idx
  ON public.sms_campaign_recipients (workspace_id, status);
CREATE INDEX IF NOT EXISTS sms_campaign_recipients_customer_idx
  ON public.sms_campaign_recipients (customer_id) WHERE customer_id IS NOT NULL;


-- RLS — workspace-scoped read, service_role full access. Send
-- pipeline + Twilio webhook use admin client.
ALTER TABLE public.sms_campaigns          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_campaign_recipients ENABLE ROW LEVEL SECURITY;

CREATE POLICY sms_campaigns_workspace_read ON public.sms_campaigns
  FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY sms_campaigns_service_all ON public.sms_campaigns
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY sms_campaign_recipients_workspace_read ON public.sms_campaign_recipients
  FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY sms_campaign_recipients_service_all ON public.sms_campaign_recipients
  FOR ALL TO service_role USING (true) WITH CHECK (true);
