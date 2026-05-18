-- Klaviyo profile staging table — temporary enrichment workspace.
--
-- This table is the bridge between Klaviyo's profile catalog and our
-- customers table during the Klaviyo sunset transition. Populated by
-- one-shot pulls (Phase 1b: SMS subscribers from segment TtP53p;
-- Phase 2b: email-only profiles found in our event data). Used to:
--   - Backfill klaviyo_profile_events.customer_id
--   - Enrich customers.timezone, default_address, first/last name
--   - Audit which Klaviyo profiles map to which customers
--
-- After enrichment is verified, this table can be dropped. The
-- permanent profile→customer cache lives in klaviyo_profile_directory
-- (separate, lean schema for cron-time resolution).

CREATE TABLE IF NOT EXISTS klaviyo_profile_staging (
  workspace_id              UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  klaviyo_profile_id        TEXT NOT NULL,

  -- Identity
  email                     TEXT,
  phone                     TEXT,
  first_name                TEXT,
  last_name                 TEXT,
  anonymous_id              TEXT,
  external_id               TEXT,
  locale                    TEXT,

  -- Location (raw from Klaviyo — derivation runs in JS)
  address1                  TEXT,
  address2                  TEXT,
  city                      TEXT,
  region                    TEXT,
  zip                       TEXT,
  country                   TEXT,
  latitude                  DOUBLE PRECISION,
  longitude                 DOUBLE PRECISION,
  timezone                  TEXT,
  ip_address                TEXT,

  -- Lineage / properties of interest
  klaviyo_created           TIMESTAMPTZ,
  klaviyo_updated           TIMESTAMPTZ,
  klaviyo_last_event_date   TIMESTAMPTZ,
  utm_source                TEXT,
  utm_medium                TEXT,
  utm_campaign              TEXT,
  utm_content               TEXT,
  consent_form_id           TEXT,

  -- Resolution
  customer_id               UUID REFERENCES customers(id) ON DELETE SET NULL,
  resolution_method         TEXT,             -- 'email' | 'phone' | null (unresolved)

  -- Audit
  source_segment            TEXT,             -- 'TtP53p' (SMS subs) or 'event_cleanup'
  synced_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace_id, klaviyo_profile_id)
);

CREATE INDEX IF NOT EXISTS klaviyo_profile_staging_customer_idx
  ON klaviyo_profile_staging (workspace_id, customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS klaviyo_profile_staging_unresolved_idx
  ON klaviyo_profile_staging (workspace_id, klaviyo_profile_id)
  WHERE customer_id IS NULL;
