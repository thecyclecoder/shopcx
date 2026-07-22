-- v3 ad-creative engine — foundation schema (goal: v3-ad-creative-engine).
--
-- The creative engine is a FACTOR MODEL ("quant for media buying"):
--   Product → Ingredient → Theme → Problem-Angle (demand-sourced) → × Headline-Pattern → Headline
-- then every posted ad is STAMPED with its factors {theme, angle, pattern, combination} so Meta
-- results attribute back and re-weight selection. This migration lays the three foundation tables
-- + the campaign stamps. See docs/brain/libraries/angle-palette.md, ad-headline-patterns.md.
--
-- 1) ad_headline_patterns  — the SHARED (per-workspace, product-agnostic) pattern library. ~13
--    reusable DR formulas keyed by awareness stage. Dahlia = Angle × Pattern → Headline; the 5
--    variations are 5 patterns on one angle.
-- 2) product_angle_palette — the CLEAN, curated per-product angle palette (the trunk→fan-out). One
--    row per (product, theme, problem). Carries the raw parts a headline needs (enemy/mechanism/
--    proof) + the demand signal (selector) + evidence_tier (proof STYLE, never a filter) + coverage
--    (times_used/last_used_at/status). Replaces the polluted, unstructured product_ad_angles for the
--    v3 path (legacy table untouched here).
-- 3) ad_creative_combinations — the coverage LEDGER at the freshness grain: one row per
--    (angle × pattern). times_used/last_used_at/status drive "never ship the same ad twice"
--    (cooldown + coverage-before-repetition) and carry the perf link for exploit.
-- Plus: factor STAMPS on ad_campaigns so the rollup can attribute CPA/CTR by theme/angle/pattern.

-- ── 1) ad_headline_patterns ─────────────────────────────────────────────────────
create table if not exists public.ad_headline_patterns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  slug text not null,                              -- 'reframe' | 'curiosity-gap' | ...
  name text not null,                              -- 'Reframe (not-X-but-Y)'
  structure text not null,                         -- '[Subject] doesn''t need more [ENEMY]. It needs [MECHANISM].'
  awareness_stages text[] not null default '{}',   -- which temperatures it serves: {cold} | {warm,hot} | ...
  consumes text[] not null default '{}',           -- angle-parts it needs: {enemy,mechanism} | {proof,outcome} | ...
  example text,                                    -- an example filled headline
  is_active boolean not null default true,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);
create index if not exists ad_headline_patterns_ws_active_idx
  on public.ad_headline_patterns (workspace_id, is_active);

-- ── 2) product_angle_palette ────────────────────────────────────────────────────
create table if not exists public.product_angle_palette (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  theme text not null,                             -- 'beauty'|'longevity'|'healthy_weight'|'energy_performance'|'focus'|'gut'
  problem text not null,                           -- 'wrinkles & aging skin'
  ingredients text[] not null default '{}',        -- {collagen,hyaluronic_acid} — double-backed = stronger
  benefit_key text,                                -- links product_benefit_selections.benefit_name (grounding)
  enemy text,                                       -- the false-solution the audience currently buys: 'serums'
  mechanism text,                                   -- 'collagen rebuilds skin from within'
  desired_outcome text,                            -- 'younger, smoother skin'
  proof_text text,                                 -- '35% wrinkle reduction at 12 weeks' | a real customer phrase
  proof_kind text,                                 -- 'clinical_stat'|'mechanism'|'customer_review'
  evidence_tier text not null default 'customer_only'
    check (evidence_tier in ('science_strong','science_modest','customer_only')),  -- proof STYLE, NOT a filter
  backing_review_ids uuid[] not null default '{}',
  search_demand text not null default 'medium'
    check (search_demand in ('high','medium','low')),  -- the SELECTOR (proxy until a keyword-volume source)
  awareness_stages text[] not null default '{cold,warm,hot}',
  source text not null default 'seeded'
    check (source in ('seeded','dahlia_fanned','competitor_mapped')),
  -- coverage / freshness
  times_used int not null default 0,
  last_used_at timestamptz,
  status text not null default 'fresh'
    check (status in ('fresh','testing','crowned','retired')),
  is_active boolean not null default true,
  display_order int not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, product_id, theme, problem)
);
create index if not exists product_angle_palette_product_idx
  on public.product_angle_palette (workspace_id, product_id, is_active);
create index if not exists product_angle_palette_theme_idx
  on public.product_angle_palette (workspace_id, product_id, theme);
create index if not exists product_angle_palette_status_idx
  on public.product_angle_palette (workspace_id, product_id, status);

-- ── 3) ad_creative_combinations (coverage ledger — angle × pattern) ──────────────
create table if not exists public.ad_creative_combinations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  angle_id uuid not null references public.product_angle_palette(id) on delete cascade,
  pattern_id uuid not null references public.ad_headline_patterns(id) on delete cascade,
  times_used int not null default 0,
  last_used_at timestamptz,
  status text not null default 'fresh'
    check (status in ('fresh','tested','crowned','retired')),
  campaign_id uuid references public.ad_campaigns(id) on delete set null,  -- last/representative campaign
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, angle_id, pattern_id)
);
create index if not exists ad_creative_combinations_product_idx
  on public.ad_creative_combinations (workspace_id, product_id, status);
create index if not exists ad_creative_combinations_angle_idx
  on public.ad_creative_combinations (angle_id);
create index if not exists ad_creative_combinations_pattern_idx
  on public.ad_creative_combinations (pattern_id);

-- ── 4) Factor STAMPS on ad_campaigns (attribution loop) ─────────────────────────
-- Every posted ad carries its factors so the rollup can attribute CPA/CTR by theme/angle/pattern.
alter table public.ad_campaigns
  add column if not exists creative_theme          text,
  add column if not exists angle_palette_id        uuid references public.product_angle_palette(id),
  add column if not exists headline_pattern_id     uuid references public.ad_headline_patterns(id),
  add column if not exists creative_combination_id uuid references public.ad_creative_combinations(id);

-- ── RLS (service-role writes; workspace members read) ───────────────────────────
alter table public.ad_headline_patterns    enable row level security;
alter table public.product_angle_palette   enable row level security;
alter table public.ad_creative_combinations enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='ad_headline_patterns' and policyname='ad_headline_patterns_service_all') then
    create policy ad_headline_patterns_service_all on public.ad_headline_patterns for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='ad_headline_patterns' and policyname='ad_headline_patterns_member_select') then
    create policy ad_headline_patterns_member_select on public.ad_headline_patterns for select to authenticated
      using (exists (select 1 from public.workspace_members m where m.workspace_id = ad_headline_patterns.workspace_id and m.user_id = auth.uid()));
  end if;

  if not exists (select 1 from pg_policies where tablename='product_angle_palette' and policyname='product_angle_palette_service_all') then
    create policy product_angle_palette_service_all on public.product_angle_palette for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='product_angle_palette' and policyname='product_angle_palette_member_select') then
    create policy product_angle_palette_member_select on public.product_angle_palette for select to authenticated
      using (exists (select 1 from public.workspace_members m where m.workspace_id = product_angle_palette.workspace_id and m.user_id = auth.uid()));
  end if;

  if not exists (select 1 from pg_policies where tablename='ad_creative_combinations' and policyname='ad_creative_combinations_service_all') then
    create policy ad_creative_combinations_service_all on public.ad_creative_combinations for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='ad_creative_combinations' and policyname='ad_creative_combinations_member_select') then
    create policy ad_creative_combinations_member_select on public.ad_creative_combinations for select to authenticated
      using (exists (select 1 from public.workspace_members m where m.workspace_id = ad_creative_combinations.workspace_id and m.user_id = auth.uid()));
  end if;
end $$;
