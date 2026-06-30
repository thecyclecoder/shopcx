-- growth-customer-voice-to-ad-angles Phase 2:
-- Adds `status` and `metadata` to product_ad_angles so synthesized voice-mined
-- candidates can land at status='proposed' (awaiting Director approval) and
-- carry their provenance (`mined_from.{review_ids,cancel_event_ids,ticket_ids}`,
-- `matrix_overlap`, `score`) without polluting the typed columns.
--
-- Existing pre-Phase-2 rows are stamped 'approved' so the legacy `is_active`
-- picker keeps working unchanged. Phase 3 will flip 'proposed' → 'approved' on
-- Director sign-off and fan into the makers pipeline.

ALTER TABLE public.product_ad_angles
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Only proposed | approved | archived for now — Phase 3 reads these.
ALTER TABLE public.product_ad_angles
  DROP CONSTRAINT IF EXISTS product_ad_angles_status_chk;
ALTER TABLE public.product_ad_angles
  ADD CONSTRAINT product_ad_angles_status_chk
  CHECK (status IN ('proposed', 'approved', 'archived'));

-- Director-brief lookup: "list newest proposed candidates for this workspace".
CREATE INDEX IF NOT EXISTS product_ad_angles_proposed_idx
  ON public.product_ad_angles (workspace_id, product_id, created_at DESC)
  WHERE status = 'proposed';
