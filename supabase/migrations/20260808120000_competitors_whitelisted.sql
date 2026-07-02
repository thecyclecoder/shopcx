-- Whitelisted-page auto-tracking (docs/brain/specs/whitelisted-page-auto-tracking.md, Phase 1).
--
-- Competitors run a large share of their paid social through non-brand pages — affiliate /
-- advertorial / creator personas that drive to the fronted brand's store (e.g. "Holistic Health
-- Finds" → learn.erthlabs.co). The AdLibrary keyword search only matches the EXACT page name
-- ("Holistic Health Finds" → 59 ads; the `normalizeBrand`-flattened "holistichealthfinds" → 0),
-- so we cannot reuse `brand` (which the writer normalizes to a compact handle) as the search
-- keyword for these rows.
--
-- Design (docs/brain/specs/whitelisted-page-auto-tracking.md option (a)): reuse this table with
-- `source='whitelisted'` + a link to the fronted competitor. The sweep already treats approved
-- competitor rows as seeds, so an approved whitelisted page "just works" as a seed once the
-- sweep read maps `keyword = search_keyword ?? brand` (Phase 2).
--
-- Idempotent — add-column-if-not-exists, drop/recreate the source CHECK to include 'whitelisted'.

alter table public.competitors
  add column if not exists search_keyword text;

comment on column public.competitors.search_keyword is
  'The EXACT AdLibrary keyword the sweep searches (verbatim, NOT normalizeBrand-flattened). '
  'Whitelisted-page rows set this to the raw advertiser/page name (e.g. "Holistic Health Finds") '
  'because the AdLibrary API matches page names literally. Normal competitors leave it null and '
  'the sweep falls back to `brand`.';

alter table public.competitors
  add column if not exists runs_ads_for uuid references public.competitors(id) on delete set null;

comment on column public.competitors.runs_ads_for is
  'For source=''whitelisted'' rows, the competitor whose store this page fronts (destination-domain '
  'join target — e.g. the "Holistic Health Finds" row points at the erthlabs competitor). Null for '
  'real brand competitors (llm / category_sweep / manual).';

-- Extend the source CHECK to include 'whitelisted' — the discovery pass writes this as
-- status='proposed' just like the other sources, and the owner approves it in-band.
alter table public.competitors
  drop constraint if exists competitors_source_check;
alter table public.competitors
  add constraint competitors_source_check
  check (source in ('llm', 'category_sweep', 'manual', 'whitelisted'));
