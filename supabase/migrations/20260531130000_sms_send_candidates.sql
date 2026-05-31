-- SMS send candidates: staging table for the dedup-before-schedule pattern.
--
-- Replaces the previous "audience-resolve writes directly to
-- sms_campaign_recipients" flow. The new shape:
--
--   1. textCampaignScheduled writes candidates here (one row per
--      campaign × phone).
--   2. promoteWave (Inngest fn, debounced ~2 min after staging) reads
--      all candidates for the same send_date wave, dedups by phone
--      using `priority ASC` (lower wins), inserts winners into
--      sms_campaign_recipients, marks candidates 'promoted' or
--      'deduped'.
--   3. textCampaignSendTick submits the recipients to Twilio as
--      before — but the per-recipient rate-limit query in the claim
--      step is no longer needed.
--
-- Why this exists: the previous in-memory rate-limit dedup (Set on
-- the tick function's outer scope) wasn't replay-safe under Inngest's
-- step-replay model. Result: Dylan got SUMMERFIT engaged AND
-- SUMMERFIT just_ordered on 2026-05-31. The per-recipient runtime
-- query I shipped earlier today fixes the correctness bug, but it
-- adds ~7K live DB queries to the high-concurrency send-tick path —
-- exactly the saturation pattern that took down the connection pool
-- during MDW. Pre-flight dedup moves the work off the hot path and
-- makes it one SQL pass instead of N queries.

CREATE TABLE IF NOT EXISTS public.sms_send_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES public.sms_campaigns(id) ON DELETE CASCADE,
  customer_id UUID,
  phone TEXT NOT NULL,
  scheduled_send_at TIMESTAMPTZ NOT NULL,
  resolved_timezone TEXT,
  timezone_source TEXT,
  preferred_hour_used INTEGER,
  -- Priority used by the dedup pass — LOWER WINS. Auto-derived from
  -- the campaign's included_segments at staging time using the segment
  -- → priority map (engaged=1, lapsed=2, just_ordered=3, ...). Admin
  -- can override per-campaign on sms_campaigns.priority once we add
  -- that column.
  priority INTEGER NOT NULL DEFAULT 100,
  -- Lifecycle: 'staged' (just inserted) → 'promoted' (won the dedup,
  -- a sms_campaign_recipients row was created) | 'deduped' (lost the
  -- dedup, another campaign claimed this phone first).
  outcome TEXT NOT NULL DEFAULT 'staged',
  promoted_recipient_id UUID,  -- back-pointer when outcome='promoted'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One candidate row per (campaign, phone). Guarantees an idempotent
  -- audience-resolve and stops "I scheduled the same campaign twice
  -- and got 2x recipients" misfires.
  UNIQUE (campaign_id, phone)
);

-- Dedup pass loads candidates for a wave (workspace + send_date) and
-- orders by priority + created_at. This index makes that loader a
-- range scan instead of a seq + sort.
CREATE INDEX IF NOT EXISTS sms_send_candidates_wave_idx
  ON public.sms_send_candidates (workspace_id, outcome, scheduled_send_at, priority);

-- Phone-based dedup queries (within a workspace) for the SQL-side
-- DISTINCT ON pass.
CREATE INDEX IF NOT EXISTS sms_send_candidates_phone_idx
  ON public.sms_send_candidates (workspace_id, phone)
  WHERE outcome = 'staged';

-- Campaign lifecycle markers — when audience was staged, when the
-- wave promoted it to recipients. Lets the promote-wave function
-- detect "ready" waves and prevents double-promotion.
ALTER TABLE public.sms_campaigns
  ADD COLUMN IF NOT EXISTS audience_staged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS audience_promoted_at TIMESTAMPTZ,
  -- Per-campaign priority override. Lower = higher priority. NULL
  -- means "auto-derive from included_segments at staging time."
  ADD COLUMN IF NOT EXISTS priority INTEGER;
