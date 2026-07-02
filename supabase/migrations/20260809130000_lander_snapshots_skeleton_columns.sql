-- Funnel Teardown Scout — Phase 2: lander skeleton (vision deconstruction).
-- (docs/brain/specs/funnel-teardown-scout.md, Phase 2)
--
-- Persist a page-type-aware structural skeleton per lander_snapshots row (per funnel step),
-- the landing-page analog of creative_skeletons for ads. Written by
-- landingPageScout.deconstructLander after a step reaches status='captured'.
--
--   page_type — short handle for the lander archetype
--               (e.g. 'advertorial', 'single-bundle PDP', 'multi-tier PDP', 'quiz', 'editorial').
--   skeleton  — jsonb: { offer_structure, big_promise, beats[{beat,does,chapters[]}], tactics[] }.

alter table public.lander_snapshots
  add column if not exists page_type text,
  add column if not exists skeleton jsonb;
