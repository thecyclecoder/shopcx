-- Funnel Teardown Scout — Phase 1: extend lander_snapshots with funnel-follow columns
-- (docs/brain/specs/funnel-teardown-scout.md, Phase 1).
--
-- Extends [[../libraries/landing-page-scout]]: after capturing a competitor lander, extract its
-- primary CTA destination and capture that next step too. Each captured step is its own
-- lander_snapshots row sharing `funnel_root_url` (the entry lander URL that groups the funnel),
-- with an incrementing `funnel_step` (0 = entry). `cta_target_url` records THIS step's extracted
-- primary CTA (may be null if no outbound-brand CTA was found).

alter table public.lander_snapshots
  add column if not exists funnel_step int not null default 0,
  add column if not exists cta_target_url text,
  add column if not exists funnel_root_url text;

-- Look up all steps of one funnel + order them.
create index if not exists lander_snapshots_funnel_root_idx
  on public.lander_snapshots (workspace_id, funnel_root_url, funnel_step);
