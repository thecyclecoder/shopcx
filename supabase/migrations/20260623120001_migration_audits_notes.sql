-- migration_audits.notes — record non-check migration annotations.
--
-- Phase 2 of docs/brain/specs/migration-pin-and-item-robustness.md: when a
-- migration drops an item it could not map to an internal variant (out of
-- stock / discontinued / no internal product), it logs the dropped line here so
-- the drop is auditable. Unlike `checks`/`last_error` (rebuilt on every
-- re-verify), `notes` is written once at record time and never overwritten by
-- verifyMigration, so the annotation survives the retry loop.
--
-- Shape: [{ type, items: [{ title, shopifyVariantId, sku, priceCents, quantity, paid }] }]

ALTER TABLE public.migration_audits
  ADD COLUMN IF NOT EXISTS notes JSONB NOT NULL DEFAULT '[]';

COMMENT ON COLUMN public.migration_audits.notes IS
  'Non-check migration annotations (e.g. dropped unmappable items). Written once at record time, never overwritten by re-verify.';
