-- Soft-exclude flag on ticket_csat so the workspace OWNER can remove a
-- product-complaint CSAT from the CS-quality metric without hard-deleting
-- the row. NULL excluded_at = counted (the default).
-- Spec: csat-owner-exclude-from-stats (Phase 1).
ALTER TABLE ticket_csat
  ADD COLUMN IF NOT EXISTS excluded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS excluded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS exclusion_reason TEXT;
