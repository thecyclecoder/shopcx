-- research_urls.teardown: Rhea's structured teardown recipe.
--
-- Phase 1 of docs/brain/specs/rhea-teardown-recipe.md (slice 2 of the acquisition-research-engine
-- goal). One-session continuation of runResearchJob: after a worthy classification, Rhea REUSES
-- the chapters already in context (no second render) to emit a structured recipe — architecture,
-- reason_sequence, levers, offer, transferable_pattern — persisted here. Cleo (slice 3) reads
-- this column to diff against our storefront and emit a build blueprint.
--
-- Chokepoint: all WRITES go through src/lib/research-urls.ts `setTeardown` via createAdminClient()
-- — the SDK validates the recipe has a non-empty architecture + levers + transferable_pattern
-- before the write (author-spec-style gate).

alter table public.research_urls
  add column if not exists teardown jsonb;
