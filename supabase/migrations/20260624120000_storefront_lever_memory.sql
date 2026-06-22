-- Lever-importance model + CRO-learnings memory — the persistent BRAIN of the
-- storefront-optimizer agent (docs/brain/specs/storefront-lever-importance-memory.md).
-- Builds on the M1 experiment + bandit framework (20260623120000_storefront_experiments.sql).
--
-- Two tables:
--   storefront_levers           — the canonical chapter→component lever taxonomy with
--                                 CRO PRIOR importances. Global (not per-workspace): the
--                                 taxonomy + CRO principles are universal. A chapter row
--                                 has parent_lever_id NULL; a component row points at its
--                                 chapter (self-FK). Seeded here.
--   storefront_lever_importance — the LEARNED posterior, one row per
--                                 (lever_id × product_id × lander_type × audience). Starts
--                                 from the lever's prior (or a general-learning transfer
--                                 seed) and is Bayesian-updated by each M1 experiment outcome
--                                 (reward = M3 predicted-LTV-proxy delta). Append-evidence,
--                                 idempotent per experiment, decays toward prior with age.
--
-- Safety invariants baked in:
--   • level CHECK ∈ chapter|component; a component must carry a parent_lever_id.
--   • default_scope / scope CHECK ∈ product_specific|general (only general transfers).
--   • lander_type CHECK ∈ pdp|listicle|beforeafter|advertorial (mirrors M1).
--   • unique (lever_id, product_id, lander_type, audience) — one posterior per cohort.
-- RLS mirrors storefront_experiments: workspace-member SELECT, service-role write.

-- ── storefront_levers — canonical chapter→component taxonomy + CRO priors ──────
create table if not exists public.storefront_levers (
  id uuid primary key default gen_random_uuid(),
  -- Self-FK: a component lever points at its chapter; a chapter has NULL.
  parent_lever_id uuid references public.storefront_levers(id) on delete cascade,
  -- Stable machine key (e.g. 'hero', 'image', 'headline', 'pricing_table'). Globally
  -- unique so an M1 experiment's free-text `lever` can resolve to exactly one row.
  lever_key text not null unique,
  -- The chapter this lever belongs to; for a chapter row, chapter == lever_key.
  chapter text not null,
  level text not null check (level in ('chapter', 'component')),
  label text not null,
  description text,
  -- CRO prior importance ∈ [0,1]. Hero dominant (#1), pricing-clarity #2 — the goal's
  -- § CRO principles; chapter ordering reflects the real funnel dwell + CTA-click share
  -- we already have (docs/brain/dashboard/storefront__funnel.md).
  prior double precision not null default 0.5 check (prior >= 0 and prior <= 1),
  -- Which lander types this lever applies to (M1 LanderType set).
  lander_types text[] not null
    default array['pdp', 'listicle', 'beforeafter', 'advertorial']::text[],
  -- Whether a learning on this lever is BELIEVED to transfer cross-product. Structural
  -- CRO levers (hero/pricing/social-proof) are 'general'; product-content levers
  -- (ingredients/benefits) are 'product_specific'. Seeds the posterior row's scope; the
  -- Growth director can override per learning.
  default_scope text not null default 'product_specific'
    check (default_scope in ('product_specific', 'general')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists storefront_levers_parent_idx
  on public.storefront_levers (parent_lever_id);
create index if not exists storefront_levers_chapter_idx
  on public.storefront_levers (chapter, level);

-- ── storefront_lever_importance — the learned posterior store ──────────────────
create table if not exists public.storefront_lever_importance (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lever_id uuid not null references public.storefront_levers(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  lander_type text not null check (lander_type in ('pdp', 'listicle', 'beforeafter', 'advertorial')),
  audience text not null default 'all',
  -- Current posterior importance ∈ [0,1] (decays toward `prior` with age).
  importance double precision not null check (importance >= 0 and importance <= 1),
  -- The value this posterior started from (cold lever prior OR a general-learning
  -- transfer seed). Decay drifts `importance` back toward this.
  prior double precision not null check (prior >= 0 and prior <= 1),
  n_tests integer not null default 0,
  last_tested_at timestamptz,
  -- Append-only contributing-experiment log: [{experiment_id, proxy_delta, signal,
  -- weight, action, at}]. The posterior is RECOMPUTED from prior + evidence, so a
  -- re-run never double-counts (idempotent, keyed by experiment_id).
  evidence jsonb not null default '[]'::jsonb,
  -- Only 'general' learnings transfer to a brand-new product cohort.
  scope text not null default 'product_specific'
    check (scope in ('product_specific', 'general')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One posterior per (lever × product × lander_type × audience).
create unique index if not exists storefront_lever_importance_cohort_idx
  on public.storefront_lever_importance (lever_id, product_id, lander_type, audience);
create index if not exists storefront_lever_importance_ws_idx
  on public.storefront_lever_importance (workspace_id, product_id, lander_type);
-- Cross-product transfer lookup: general learnings for a (lever, lander_type, audience).
create index if not exists storefront_lever_importance_general_idx
  on public.storefront_lever_importance (lever_id, lander_type, audience)
  where scope = 'general';

-- ── RLS — workspace-member SELECT, service-role write ──────────────────────────
-- storefront_levers is a global taxonomy: any authenticated user may read it.
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
-- Chapters first (parent_lever_id NULL). Idempotent via on-conflict on lever_key.
insert into public.storefront_levers (lever_key, chapter, level, label, description, prior, default_scope)
values
  ('hero',          'hero',          'chapter', 'Hero',          'Above-the-fold hero block — the dominant lever (message-match, benefit-forward).', 0.95, 'general'),
  ('pricing_table', 'pricing_table', 'chapter', 'Pricing table', 'Pricing / pack-selection clarity — the #2 lever after the hero.',                  0.85, 'general'),
  ('cta',           'cta',           'chapter', 'CTA',           'The one clear call-to-action (copy + placement + repetition).',                    0.70, 'general'),
  ('social_proof',  'social_proof',  'chapter', 'Social proof',  'Reviews / ratings / testimonials placed near the decision.',                       0.65, 'general'),
  ('benefits',      'benefits',      'chapter', 'Benefits',      'Benefit / pain-point narrative (what it does for them — the #1 CRO rule).',         0.60, 'product_specific'),
  ('ingredients',   'ingredients',   'chapter', 'Ingredients',   'Ingredient list / sourcing story / supplement facts.',                             0.45, 'product_specific'),
  ('guarantee',     'guarantee',     'chapter', 'Guarantee',     'Risk-reversal / money-back guarantee (friction reduction).',                       0.40, 'general'),
  ('faq',           'faq',           'chapter', 'FAQ',           'Objection-handling FAQ near the close.',                                           0.30, 'general')
on conflict (lever_key) do nothing;

-- Components (parent_lever_id resolves to the chapter by lever_key).
insert into public.storefront_levers (parent_lever_id, lever_key, chapter, level, label, description, prior, default_scope)
values
  -- hero = image · headline · benefit_chips · review_snippet · trust_badges
  ((select id from public.storefront_levers where lever_key='hero'),         'image',             'hero',          'component', 'Hero image',          'The hero image / visual.',                         0.80, 'general'),
  ((select id from public.storefront_levers where lever_key='hero'),         'headline',          'hero',          'component', 'Headline',            'The hero headline (ad message-match).',            0.78, 'general'),
  ((select id from public.storefront_levers where lever_key='hero'),         'benefit_chips',     'hero',          'component', 'Benefit chips',       'Above-fold benefit chips.',                        0.55, 'general'),
  ((select id from public.storefront_levers where lever_key='hero'),         'review_snippet',    'hero',          'component', 'Hero review snippet', 'Star/review snippet in the hero.',                 0.50, 'general'),
  ((select id from public.storefront_levers where lever_key='hero'),         'trust_badges',      'hero',          'component', 'Trust badges',        'Trust / payment / guarantee badges in the hero.',  0.45, 'general'),
  -- pricing_table components
  ((select id from public.storefront_levers where lever_key='pricing_table'),'price_anchor',      'pricing_table', 'component', 'Price anchor',        'The compare-at / anchor price.',                   0.65, 'general'),
  ((select id from public.storefront_levers where lever_key='pricing_table'),'discount_framing',  'pricing_table', 'component', 'Discount framing',    'How the discount / savings is framed.',            0.60, 'general'),
  ((select id from public.storefront_levers where lever_key='pricing_table'),'pack_options',      'pricing_table', 'component', 'Pack options',        'Pack / quantity option presentation + ordering.',  0.55, 'general'),
  ((select id from public.storefront_levers where lever_key='pricing_table'),'subscription_toggle','pricing_table','component', 'Subscription toggle', 'Subscribe-and-save vs one-time toggle framing.',   0.50, 'general'),
  -- social_proof components
  ((select id from public.storefront_levers where lever_key='social_proof'), 'review_count',      'social_proof',  'component', 'Review count',        'Displayed review count.',                          0.45, 'general'),
  ((select id from public.storefront_levers where lever_key='social_proof'), 'star_rating',       'social_proof',  'component', 'Star rating',         'Aggregate star rating display.',                   0.45, 'general'),
  ((select id from public.storefront_levers where lever_key='social_proof'), 'testimonial_quote', 'social_proof',  'component', 'Testimonial quote',   'Featured testimonial quote.',                      0.50, 'general'),
  ((select id from public.storefront_levers where lever_key='social_proof'), 'ugc_photo',         'social_proof',  'component', 'UGC photo',           'User-generated content / customer photo.',         0.40, 'general'),
  -- benefits components
  ((select id from public.storefront_levers where lever_key='benefits'),     'benefit_headline',  'benefits',      'component', 'Benefit headline',    'The lead benefit headline.',                       0.60, 'product_specific'),
  ((select id from public.storefront_levers where lever_key='benefits'),     'pain_point',        'benefits',      'component', 'Pain point',          'The pain-point framing.',                          0.58, 'product_specific'),
  -- ingredients components
  ((select id from public.storefront_levers where lever_key='ingredients'),  'sourcing_story',    'ingredients',   'component', 'Sourcing story',      'The ingredient sourcing / origin story.',          0.42, 'product_specific'),
  ((select id from public.storefront_levers where lever_key='ingredients'),  'ingredient_list',   'ingredients',   'component', 'Ingredient list',     'The ingredient list presentation.',                0.40, 'product_specific'),
  ((select id from public.storefront_levers where lever_key='ingredients'),  'supplement_facts',  'ingredients',   'component', 'Supplement facts',    'Supplement-facts panel.',                          0.30, 'product_specific'),
  -- cta components
  ((select id from public.storefront_levers where lever_key='cta'),          'button_copy',       'cta',           'component', 'Button copy',         'The CTA button copy.',                             0.50, 'general'),
  ((select id from public.storefront_levers where lever_key='cta'),          'cta_placement',     'cta',           'component', 'CTA placement',       'Where / how often the CTA repeats.',               0.45, 'general'),
  -- guarantee components
  ((select id from public.storefront_levers where lever_key='guarantee'),    'guarantee_copy',    'guarantee',     'component', 'Guarantee copy',      'The money-back-guarantee copy.',                   0.38, 'general'),
  -- faq components
  ((select id from public.storefront_levers where lever_key='faq'),          'objection_list',    'faq',           'component', 'Objection list',      'The FAQ objection-handling list.',                 0.30, 'general')
on conflict (lever_key) do nothing;
