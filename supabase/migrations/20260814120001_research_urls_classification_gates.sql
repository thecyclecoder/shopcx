-- rhea-research-automation spec, Phase 2 — deterministic gate at sync time.
--
-- Two new documented values on public.research_urls.classification: `excluded` (a non-lander
-- domain — social/login/app-store/aggregator/search) and `checkout` (a checkout page — out of
-- scope for the lander teardown pipeline). The sync SDK (src/lib/research-urls.ts
-- `syncResearchUrlsFromCreatives`) pre-stamps these deterministically as each destination is
-- upserted, so they're INVISIBLE to the Phase-1 research-sensor claim (`classification IS NULL`)
-- while remaining KEPT + AUDITABLE (we know why they were skipped) rather than dropped.
--
-- No enum migration — classification stays a plain TEXT column; only the CHECK constraint widens.
-- Idempotent: drop-if-exists then re-add. Safe to re-run.

alter table public.research_urls
  drop constraint if exists research_urls_classification_check;

alter table public.research_urls
  add constraint research_urls_classification_check
  check (
    classification is null
    or classification in (
      'advertorial',
      'quiz',
      'generic_pdp',
      'homepage',
      'spam',
      'unviewable',
      'excluded',
      'checkout'
    )
  );
