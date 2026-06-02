-- Once an agent confirms which customer a Meta sender is, we record
-- the (meta_sender_id → customer_id) pairing so future comments from
-- the same FB/IG account never need to be matched again. Future
-- ingest looks it up before falling back to fuzzy-name matching.
CREATE TABLE IF NOT EXISTS meta_sender_customer_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meta_sender_id  TEXT NOT NULL,           -- FB user id or IG user id
  meta_sender_name TEXT,                   -- snapshot at link time, for UI
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  confirmed_by    UUID,                    -- workspace_member who confirmed
  confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, meta_sender_id)
);

CREATE INDEX IF NOT EXISTS meta_sender_customer_links_customer_idx
  ON meta_sender_customer_links (customer_id);

ALTER TABLE meta_sender_customer_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_meta_sender_links" ON meta_sender_customer_links
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "auth_read_meta_sender_links" ON meta_sender_customer_links
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));

-- Add customer_id to social_comments so a comment carries the linked
-- customer directly (no lookup needed on display). Backfilled when an
-- agent confirms a match: every existing comment from that sender is
-- stamped with the customer_id at confirm time.
ALTER TABLE public.social_comments
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS social_comments_customer_idx
  ON social_comments (customer_id) WHERE customer_id IS NOT NULL;
