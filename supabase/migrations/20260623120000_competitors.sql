-- Competitor Scout — DB-driven per-product competitor set (docs/brain/specs/competitor-scout.md, Phase 1).
--
-- The foundation of the Acquisition Research Engine (M1). Replaces the hardcoded COMPETITOR_SEEDS
-- in src/lib/adlibrary.ts (which violated "never hardcoded, always DB-driven") with a curated,
-- supervisable table. Both downstream scouts (ad-creative-scout M2, landing-page-scout M3) read this
-- approved set — neither re-derives competitors.
--
-- Supervisable / north-star: the discovery agent writes competitor candidates as status='proposed'
-- WITH evidence (why they compete + an ad-spend signal); the owner approves → 'approved'. The
-- creative-finder sweep only ever pulls 'approved' rows, so a proposed/rejected competitor never
-- silently enters the live sweep. A rejected competitor stays a row (UNIQUE brand) so it does not
-- re-surface from a later discovery/category-sweep pass.
--
-- Sources:
--   'llm'           — LLM + web search proposed the brand (the direct competitive set + domain/PDPs)
--   'category_sweep'— a heavy advertiser recurred in AdLibrary category sweeps and was promoted
--   'manual'        — hand-curated (incl. the 11 migrated COMPETITOR_SEEDS, seeded 'approved' below)
--
-- product_id is the product they compete with (nullable — workspace-level competitors, and the
-- migrated seeds, are not tied to a single product UUID). The sweep reads at workspace scope.
-- RLS mirrors the ad-tool tables: workspace-member SELECT, service-role write.

create table if not exists public.competitors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The product they compete with (provenance). Nullable: workspace-level competitors and the
  -- migrated seeds have no single product. ON DELETE SET NULL keeps the competitor if the product goes.
  product_id uuid references public.products(id) on delete set null,

  -- The brand handle used AS the AdLibrary search keyword (the API has no brand filter). Normalized
  -- lowercase by the writer so UNIQUE(workspace_id, brand) dedups + blocks re-surfacing.
  brand text not null,
  -- Canonical brand domain (e.g. 'ryzesuperfoods.com') — the bridge to landing-page-scout.
  domain text,
  -- Canonical PDP / lander URLs (breadth source for landing-page-scout).
  pdp_urls text[] not null default '{}',
  category text,
  -- Ad-spend / longevity signal supporting "they compete heavily" (freeform: 'high', 'recurring in
  -- 3 category sweeps', estimated spend, …).
  spend_signal text,

  source text not null default 'manual' check (source in ('llm', 'category_sweep', 'manual')),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  -- Why they compete (the supervisable evidence shown to the owner before approval).
  evidence text,

  -- Approve/reject audit trail (mirrors iteration_recommendations).
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One competitor brand per workspace ⇒ dedup across discovery passes + category-sweep promotion,
  -- and a rejected brand cannot re-surface (ON CONFLICT DO NOTHING on the brand key).
  unique (workspace_id, brand)
);

-- The sweep reads "approved competitors for this workspace"; the owner surface lists by status.
create index if not exists competitors_workspace_status_idx
  on public.competitors (workspace_id, status);
-- Per-product competitor lookup (the discovery agent's "does this product have rows?" check).
create index if not exists competitors_workspace_product_idx
  on public.competitors (workspace_id, product_id);

alter table public.competitors enable row level security;
drop policy if exists competitors_select on public.competitors;
create policy competitors_select on public.competitors
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
drop policy if exists competitors_service on public.competitors;
create policy competitors_service on public.competitors
  for all to service_role using (true) with check (true);

-- ── Migrate the 11 hardcoded COMPETITOR_SEEDS → approved rows ─────────────────────────────────
-- One row per (ad-tool workspace × seed). Ad-tool workspaces are those that own ad_campaigns —
-- the exact set the creative-finder sweep runs for. status='approved' so they flow straight into
-- the sweep (they were already the live list). product_id stays null (workspace-level); the seed's
-- note (which of our products they compete with) is preserved in `evidence`.
insert into public.competitors (workspace_id, brand, source, status, evidence)
select ws.workspace_id, seed.brand, 'manual', 'approved', seed.evidence
from (values
  ('everydaydose',   'Competes with Amazing Coffee (migrated from COMPETITOR_SEEDS)'),
  ('ryze',           'Competes with Amazing Coffee (migrated from COMPETITOR_SEEDS)'),
  ('lifeboost',      'Competes with Amazing Coffee (migrated from COMPETITOR_SEEDS)'),
  ('urthlabs',       'Competes with Amazing Coffee · anti-aging (migrated from COMPETITOR_SEEDS)'),
  ('erthlabs',       'Competes with Amazing Coffee · anti-aging, alt spelling (migrated from COMPETITOR_SEEDS)'),
  ('leanjoebean',    'Competes with Amazing Coffee · weight-loss (migrated from COMPETITOR_SEEDS)'),
  ('atlascoffeeclub','Competes with Amazing Coffee (migrated from COMPETITOR_SEEDS)'),
  ('piquelife',      'Competes with Amazing Coffee (migrated from COMPETITOR_SEEDS)'),
  ('mudwtr',         'Competes with Amazing Coffee (migrated from COMPETITOR_SEEDS)'),
  ('onnit',          'Competes with Ashwavana (migrated from COMPETITOR_SEEDS)'),
  ('bloomnu',        'Superfood/greens cross-competitor (migrated from COMPETITOR_SEEDS)')
) as seed(brand, evidence)
cross join (select distinct workspace_id from public.ad_campaigns) ws
on conflict (workspace_id, brand) do nothing;
