-- Migration verification audit — one row per Appstle→internal migration.
--
-- After a sub is migrated, we run a checklist (is_internal flip clean, Shopify
-- ids gone, items on UUIDs, Appstle actually cancelled, pricing preserved, no
-- double-bill). The row records the result so a dashboard can surface anything
-- stuck, and an Inngest retry loop can re-verify pending/failed rows a bounded
-- number of times before flagging for manual review.
--
-- North star: after status='passed', the sub is guaranteed to bill on its next
-- renewal. A 'failed' row is a renewal at risk — surface it loudly.

CREATE TABLE IF NOT EXISTS public.migration_audits (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  subscription_id          UUID NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  -- The Appstle contract id the sub had BEFORE the flip (numeric), so we can
  -- re-fetch it to confirm it was cancelled.
  appstle_contract_id      TEXT,
  -- The native internal-* contract id after the flip.
  internal_contract_id     TEXT,
  -- Sum of the live Appstle per-line charge (currentPrice × qty) captured at
  -- migration time — check 6 compares this to the internal engine's charge.
  pre_migration_charge_cents INTEGER,
  is_recovery              BOOLEAN NOT NULL DEFAULT false,
  status                   TEXT NOT NULL DEFAULT 'pending', -- pending | passed | failed
  checks                   JSONB NOT NULL DEFAULT '[]',     -- [{ key, ok, detail }]
  retry_count              INTEGER NOT NULL DEFAULT 0,
  last_error               TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_migration_audits_workspace_status
  ON public.migration_audits(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_migration_audits_subscription
  ON public.migration_audits(subscription_id);

COMMENT ON TABLE public.migration_audits IS
  'One row per Appstle→internal migration. Checklist results + status (pending/passed/failed) so the monitor surfaces stuck migrations and the retry loop re-verifies before flagging.';
