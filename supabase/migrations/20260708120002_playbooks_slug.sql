-- Phase 1 of docs/brain/specs/sol-session-chosen-playbook-selection-retire-brittle-triggers.md
--
-- Adds a stable URL-safe `slug` identifier to `public.playbooks` so Sol's first-touch box session
-- can name the chosen playbook on the Direction (`plan.playbook_slug`) and downstream cheap-
-- execution can resolve it deterministically. Existing dashboards already treat `name` as the
-- effective slug in aggregations (see src/app/api/tickets/analytics/sol-cost/route.ts §
-- per_playbook_slug) — this migration promotes that convention into a proper column so the
-- writeDirection lookup at src/lib/ticket-directions.ts can constrain to it.
--
-- Backfill: derives the slug from `name` (lowercased, non-alnum → single '-', trimmed) so
-- existing rows get a deterministic slug without a hand-migration. Post-backfill the column is
-- NOT NULL and unique per workspace.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS · CREATE UNIQUE INDEX IF NOT EXISTS).

ALTER TABLE public.playbooks ADD COLUMN IF NOT EXISTS slug TEXT;

UPDATE public.playbooks
SET slug = trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'))
WHERE slug IS NULL;

ALTER TABLE public.playbooks ALTER COLUMN slug SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS playbooks_workspace_slug_key
  ON public.playbooks (workspace_id, slug);

COMMENT ON COLUMN public.playbooks.slug IS
  'URL-safe identifier for the playbook, unique per workspace. Written on ticket_directions.plan.playbook_slug when Sol chooses playbook chosen_path in the first-touch box session (docs/brain/specs/sol-session-chosen-playbook-selection-retire-brittle-triggers.md Phase 1).';
