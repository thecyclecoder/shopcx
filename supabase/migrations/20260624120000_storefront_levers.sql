-- Storefront lever-importance model + CRO-learnings memory — the persistent BRAIN
-- of the storefront-optimizer agent (docs/brain/specs/storefront-lever-importance-memory.md, M2).
--
-- Two tables:
--   storefront_levers           — the canonical, GLOBAL chapter→component lever taxonomy
--                                 (hero, pricing-table, social-proof, …; hero = image · headline ·
--                                 benefit_chips · review_snippet · trust_badges). Each lever carries a
--                                 CRO PRIOR importance. Chapter-level priors reflect the real funnel-data
--                                 dwell/CTA ranking (hero #1, pricing-clarity #2). Self-FK parent_lever_id
--                                 wires component → chapter.
--   storefront_lever_importance — the LEARNED posterior, one row per
--                                 (lever × product × lander_type × audience): the current `importance`,
--                                 the `prior` it started from, `n_tests`, `last_tested_at`, the append-only
--                                 `evidence` (contributing experiment ids + their proxy deltas), and a
--                                 `scope` ∈ product_specific｜general for cross-product transfer.
--
-- Safety invariants baked in here:
--   • lever kind CHECK ∈ chapter|component, with parent_lever_id null⇔chapter / set⇔component
--   • prior / importance CHECK in [0,1]
--   • lander_type applicability stored as a text[] (subset of pdp|listicle|beforeafter|advertorial)
--   • posterior uniqueness on (lever_id, product_id, lander_type, audience) — one learning per cell
--   • evidence is append-only jsonb; a posterior is DERIVED from prior + evidence (never destructively set)
-- RLS mirrors storefront_experiments: workspace-member SELECT, service-role write. The taxonomy is
-- global (no workspace_id) so it's readable by any authenticated member.

-- ── storefront_levers — the canonical taxonomy + CRO priors ───────────────────
create table if not exists public.storefront_levers (
  id uuid primary key default gen_random_uuid(),
  -- Self-FK: null for a chapter-level lever, the parent chapter for a component-level one.
  parent_lever_id uuid references public.storefront_levers(id) on delete cascade,
  -- Globally-unique stable key (e.g. 'hero', 'image', 'headline'); matches an experiment's `lever`.
  lever_key text not null unique,
  -- The chapter this lever belongs to (for a chapter-level lever, == lever_key).
  chapter text not null,
  level text not null check (level in ('chapter', 'component')),
  label text not null,
  description text,
  -- CRO prior importance in [0,1]. Chapter-level priors reflect funnel dwell/CTA share (hero #1).
  prior double precision not null default 0.3 check (prior >= 0 and prior <= 1),
  -- Which lander types this lever applies to (subset of pdp|listicle|beforeafter|advertorial).
  lander_types text[] not null default array['pdp', 'listicle', 'beforeafter', 'advertorial'],
  -- Default scope a fresh learning on this lever inherits. `general` learnings transfer
  -- cross-product (universal CRO levers); `product_specific` ones don't.
  default_scope text not null default 'product_specific' check (default_scope in ('product_specific', 'general')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A component must have a parent chapter; a chapter must not.
  constraint storefront_levers_level_parent check (
    (level = 'chapter' and parent_lever_id is null) or
    (level = 'component' and parent_lever_id is not null)
  )
);

create index if not exists storefront_levers_parent_idx
  on public.storefront_levers (parent_lever_id);
create index if not exists storefront_levers_chapter_idx
  on public.storefront_levers (chapter);

-- ── storefront_lever_importance — the learned posterior store ──────────────────
create table if not exists public.storefront_lever_importance (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lever_id uuid not null references public.storefront_levers(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  lander_type text not null check (lander_type in ('pdp', 'listicle', 'beforeafter', 'advertorial')),
  audience text not null default 'all',
  -- Current posterior importance (decay-adjusted) in [0,1].
  importance double precision not null default 0.3 check (importance >= 0 and importance <= 1),
  -- The prior this cell started from (lever CRO prior, or a transferred `general` seed).
  prior double precision not null default 0.3 check (prior >= 0 and prior <= 1),
  n_tests integer not null default 0,
  last_tested_at timestamptz,
  -- Append-only evidence: array of { experiment_id, proxy_delta, effect, won, source, at }.
  -- The posterior is DERIVED from prior + these effects (a loss is recorded as much as a win).
  evidence jsonb not null default '[]'::jsonb,
  scope text not null default 'product_specific' check (scope in ('product_specific', 'general')),
  -- Where the initial prior came from: 'cro_prior' | 'general_transfer' (cross-product seed).
  seeded_from text not null default 'cro_prior',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One posterior per (lever × product × lander_type × audience) cell.
create unique index if not exists storefront_lever_importance_cell_uniq
  on public.storefront_lever_importance (lever_id, product_id, lander_type, audience);
create index if not exists storefront_lever_importance_ws_idx
  on public.storefront_lever_importance (workspace_id, product_id, lander_type, audience);
-- Cross-product transfer lookup: the `general`-scoped rows for a lever.
create index if not exists storefront_lever_importance_general_idx
  on public.storefront_lever_importance (lever_id, scope);

-- ── RLS — workspace-member SELECT, service-role write (mirror storefront_experiments) ──
alter table public.storefront_levers enable row level security;
drop policy if exists storefront_levers_select on public.storefront_levers;
create policy storefront_levers_select on public.storefront_levers
  for select to authenticated using (auth.uid() is not null);
drop policy if exists storefront_levers_service on public.storefront_levers;
create policy storefront_levers_service on public.storefront_levers
  for all to service_role using (true) with check (true);

alter table public.storefront_lever_importance enable row level security;
drop policy if exists storefront_lever_importance_select on public.storefront_lever_importance;
create policy storefront_lever_importance_select on public.storefront_lever_importance
  for select to authenticated using (auth.uid() is not null);
drop policy if exists storefront_lever_importance_service on public.storefront_lever_importance;
create policy storefront_lever_importance_service on public.storefront_lever_importance
  for all to service_role using (true) with check (true);

-- ── Seed the canonical taxonomy + CRO priors ──────────────────────────────────
-- Chapter level — ranked by the funnel-data dwell/CTA share we already have:
-- hero dominant (#1), pricing-table clarity (#2), social proof near the decision, then the rest.
insert into public.storefront_levers (lever_key, chapter, level, label, prior, default_scope, description) values
  ('hero',          'hero',          'chapter', 'Hero',                0.90, 'general',          'The above-the-fold hook — the dominant CRO lever.'),
  ('pricing_table', 'pricing_table', 'chapter', 'Pricing table',       0.78, 'general',          'Pricing/offer clarity at the decision — CRO lever #2.'),
  ('social_proof',  'social_proof',  'chapter', 'Social proof',        0.62, 'general',          'Reviews/ratings/testimonials placed near the decision.'),
  ('benefits',      'benefits',      'chapter', 'Benefits',            0.58, 'general',          'Benefit/pain-point framing over features.'),
  ('cta',           'cta',           'chapter', 'Primary CTA',         0.50, 'general',          'One clear call to action / friction reduction.'),
  ('ingredients',   'ingredients',   'chapter', 'Ingredients',         0.42, 'product_specific', 'Ingredient/what''s-inside section.'),
  ('how_it_works',  'how_it_works',  'chapter', 'How it works',        0.40, 'product_specific', 'Mechanism / how-to-use explainer.'),
  ('guarantee',     'guarantee',     'chapter', 'Guarantee',           0.35, 'general',          'Money-back / risk-reversal block.'),
  ('faq',           'faq',           'chapter', 'FAQ',                 0.30, 'product_specific', 'Objection-handling FAQ.')
on conflict (lever_key) do nothing;

-- Component level — decompose the hero (the dominant chapter).
insert into public.storefront_levers (lever_key, chapter, level, parent_lever_id, label, prior, default_scope, description)
select v.lever_key, 'hero', 'component', p.id, v.label, v.prior, v.default_scope, v.description
from (values
  ('image',         'Hero image',        0.62, 'general',          'The hero visual.'),
  ('headline',      'Hero headline',     0.58, 'general',          'The above-the-fold headline (message-match to the ad).'),
  ('benefit_chips', 'Benefit chips',     0.45, 'general',          'The quick benefit bullets/chips under the hero.'),
  ('review_snippet','Hero review snippet',0.40,'general',          'Inline star-rating + review snippet in the hero.'),
  ('trust_badges',  'Trust badges',      0.32, 'general',          'Trust/seal badges in the hero.')
) as v(lever_key, label, prior, default_scope, description)
cross join public.storefront_levers p
where p.lever_key = 'hero'
on conflict (lever_key) do nothing;

-- Component level — decompose the pricing table (clarity #2).
insert into public.storefront_levers (lever_key, chapter, level, parent_lever_id, label, prior, default_scope, description)
select v.lever_key, 'pricing_table', 'component', p.id, v.label, v.prior, v.default_scope, v.description
from (values
  ('price_anchor',  'Price anchor',      0.55, 'general',          'The anchor/compare-at price.'),
  ('discount_badge','Discount badge',    0.48, 'general',          'The discount/savings badge — watch for churn over-prediction (M3).'),
  ('pack_options',  'Pack options',      0.45, 'general',          'The pack/quantity option layout.'),
  ('guarantee_line','Pricing guarantee', 0.38, 'general',          'The risk-reversal line at the pricing table.')
) as v(lever_key, label, prior, default_scope, description)
cross join public.storefront_levers p
where p.lever_key = 'pricing_table'
on conflict (lever_key) do nothing;

-- Component level — decompose social proof.
insert into public.storefront_levers (lever_key, chapter, level, parent_lever_id, label, prior, default_scope, description)
select v.lever_key, 'social_proof', 'component', p.id, v.label, v.prior, v.default_scope, v.description
from (values
  ('testimonial',   'Testimonial',       0.45, 'general',          'A featured customer testimonial.'),
  ('review_count',  'Review count',      0.42, 'general',          'The aggregate review count.'),
  ('star_rating',   'Star rating',       0.40, 'general',          'The aggregate star rating.'),
  ('ugc_photo',     'UGC photo',         0.35, 'product_specific', 'User-generated product photos.')
) as v(lever_key, label, prior, default_scope, description)
cross join public.storefront_levers p
where p.lever_key = 'social_proof'
on conflict (lever_key) do nothing;
