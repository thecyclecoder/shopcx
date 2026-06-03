-- Ad tool — cache the JOINT four-field demographic archetypes per product.
--
-- demographics_snapshots already holds the per-product demographic aggregate, but
-- only as MARGINAL distributions (gender / age / income separately). The avatar
-- proposal generator needs the JOINT tuple (gender × age_range × life_stage ×
-- income_bracket) to form archetypes like "Female · 55-64 · family · 80-100k".
--
-- Rather than recompute that join from ~1000 raw customer_demographics rows on
-- every "Suggest avatars" click, we cache the computed archetypes + basis here.
-- The proposal generator write-through-caches on first compute; a force-refresh
-- recomputes. Shape:
--   { basis: { cohort_size, gender_share, age_range_share, life_stage_share,
--              income_bracket_share, used_fallback_snapshot },
--     archetypes: [ { tuple: {gender,age_range,life_stage,income_bracket}, share } ],
--     computed_at: iso }
ALTER TABLE public.demographics_snapshots
  ADD COLUMN IF NOT EXISTS archetype_tuples JSONB;

COMMENT ON COLUMN public.demographics_snapshots.archetype_tuples IS
  'Cached JOINT four-field demographic archetypes (gender×age×life_stage×income) + cohort basis for the ad-tool avatar proposal generator. Write-through cache; recomputed on force-refresh. Only the four-field tuple — never health_priorities/buyer_type/geo.';
