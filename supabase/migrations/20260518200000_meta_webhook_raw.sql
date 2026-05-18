-- Capture raw incoming Meta webhook bodies so we can see every field
-- Meta sends us (incl. the optional gender/birthday/name fields the
-- admin can enable in the Meta App Dashboard webhook subscription).
-- 7-day retention; the table is for debugging only, not load-bearing.

CREATE TABLE IF NOT EXISTS meta_webhook_raw (
  id              BIGSERIAL PRIMARY KEY,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  signature_valid BOOLEAN,
  body            JSONB NOT NULL,
  headers         JSONB
);

CREATE INDEX IF NOT EXISTS meta_webhook_raw_received_at_idx
  ON meta_webhook_raw (received_at DESC);

ALTER TABLE meta_webhook_raw ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON meta_webhook_raw
  FOR ALL TO service_role USING (true) WITH CHECK (true);
