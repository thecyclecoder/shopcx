-- lander_blueprints: link the authored build spec.
--
-- Phase 2 of docs/brain/specs/content-upload-and-lander-build.md — the deterministic
-- verify + build-spec handoff to devops. When a blueprint's bucket is whole (every
-- skeleton block has copy + every image slot is filled), Cleo (deterministic) authors a
-- lander BUILD spec through [[author-spec]] `authorSpecRowStructured`, then flips the
-- blueprint to `build_submitted` — this column records the spec slug it landed at so
-- a reader can jump from the blueprint to its build spec (and its Ada disposition + PR).
--
-- Nullable + defaults NULL — every blueprint prior to Phase 2 predates the handoff, and
-- the column is set exactly once when status flips from content_complete → build_submitted.
-- Free-text (spec slugs are kebab-case strings — no FK to public.specs because the spec
-- may be deleted / renamed and the blueprint should not cascade).

ALTER TABLE public.lander_blueprints
  ADD COLUMN IF NOT EXISTS build_spec_slug text;

-- Read-path: "given a spec slug, find the blueprint that authored it" (useful when Ada
-- disposes the spec and needs to bounce a diagnosis back onto the blueprint). Partial
-- index so we only cover the rows that have a spec attached.
CREATE INDEX IF NOT EXISTS lander_blueprints_workspace_build_spec_slug_idx
  ON public.lander_blueprints (workspace_id, build_spec_slug)
  WHERE build_spec_slug IS NOT NULL;
