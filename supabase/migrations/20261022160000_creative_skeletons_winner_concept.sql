-- winners-flow Phase 2b — the unified concept breakdown on each competitor ad. LANE A (winners scan)
-- stores AdLibrary's AI scoring/tags directly; LANE B (domain search) + the backfill fill concept_tags via
-- OUR vision using the SAME rubric — so every ad in the library carries one shape for Dahlia + Max.
alter table public.creative_skeletons
  add column if not exists winner_tier  text,          -- high_confidence_winner | winner | middle | loser | emerging (LANE A)
  add column if not exists winner_score numeric,        -- AdLibrary composite score 0-1 (LANE A)
  add column if not exists concept_tags jsonb;          -- { angle, archetype, why_it_works, cialdini_lever, awareness_stage, format }

comment on column public.creative_skeletons.concept_tags is
  'Unified concept breakdown (winners-flow). LANE A: AdLibrary''s winner tags. LANE B / backfill: OUR vision '
  'emits the same schema { angle, archetype, why_it_works, cialdini_lever, awareness_stage, format } so Dahlia '
  'researches + Max grades a consistent shape across both collection lanes.';

create index if not exists creative_skeletons_winner_tier_idx
  on public.creative_skeletons (workspace_id, winner_tier) where winner_tier is not null;
