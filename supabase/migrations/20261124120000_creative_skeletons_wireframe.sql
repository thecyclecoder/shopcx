-- Skeleton redesign: agnostic wireframe (element × zone × role × prominence).
--
-- The v3 Ad Creative Engine goal recasts creative_skeletons from
-- substance-oriented (hook / mechanism_claim / proof / offer as bare strings)
-- to scaffold-oriented (an elements array — each with zone + role + prominence —
-- plus product_presentation + punchiness tags). This phase adds the columns
-- ADDITIVELY so no existing reader regresses; the substance columns stay for
-- the analyzed-competitor archive but the M4 decision engine (blocked_by this
-- spec) will read elements[] for reuse decisions.
--
-- Additive-only: no drops, no NOT NULLs, no data reshaping. RLS is unchanged
-- (creative_skeletons_select / _service carry the new columns).
--
-- See docs/brain/specs/skeleton-agnostic-wireframe-redesign.md · Phase 1.

alter table public.creative_skeletons
  add column if not exists elements jsonb,
  add column if not exists product_presentation text[] not null default '{}',
  add column if not exists punchiness text[] not null default '{}';

-- Elements array shape gate: when set, every element must be a jsonb object
-- with a whitelisted zone + role and a prominence between 0 and 1. Enforced
-- via a NOT EXISTS over jsonb_array_elements so a single malformed element
-- fails the whole write — the same shape-gate style used for e.g.
-- offers_included_is_array + cs_director_digests_storylines_is_array in
-- migrations from 2026-09.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'creative_skeletons_elements_shape_chk'
      and conrelid = 'public.creative_skeletons'::regclass
  ) then
    alter table public.creative_skeletons
      add constraint creative_skeletons_elements_shape_chk check (
        elements is null
        or (
          jsonb_typeof(elements) = 'array'
          and not exists (
            select 1
            from jsonb_array_elements(elements) as elem
            where
              jsonb_typeof(elem) <> 'object'
              or not (elem ? 'zone' and elem ? 'role' and elem ? 'prominence')
              or (elem ->> 'zone') not in ('header','hero','body','footer','cta')
              or (elem ->> 'role') not in ('hook','mechanism','proof','offer','risk_reversal','social_proof','price')
              or jsonb_typeof(elem -> 'prominence') <> 'number'
              or (elem ->> 'prominence')::numeric < 0
              or (elem ->> 'prominence')::numeric > 1
          )
        )
      );
  end if;
end$$;

comment on column public.creative_skeletons.elements is
  'Agnostic wireframe: array of {zone: header|hero|body|footer|cta, role: hook|mechanism|proof|offer|risk_reversal|social_proof|price, prominence: 0..1}. Scaffold-only — the substance columns (hook/mechanism_claim/proof/offer) still carry the raw phrases pulled from the analyzed competitor. See docs/brain/specs/skeleton-agnostic-wireframe-redesign.md.';
comment on column public.creative_skeletons.product_presentation is
  'Vision-emitted tags describing how the product is shown: packshot | lifestyle | founder | none. Empty array on legacy rows until Phase 2 backfill writes it.';
comment on column public.creative_skeletons.punchiness is
  'Vision-emitted tags describing the copy cadence: short_line | pattern_interrupt | number | contrast. Empty array on legacy rows until Phase 2 backfill writes it.';
