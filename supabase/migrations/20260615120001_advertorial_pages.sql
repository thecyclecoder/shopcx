-- Auto-generated ad-matched landers (advertorial + before/after).
--
-- One row per (product, ad angle) = the generated editorial TOP of a lander
-- (hero + chapter 1). Everything below the top is the existing PDP, reused
-- unchanged at render time. Reached via ?variant=advertorial|beforeafter&angle={slug}
-- on the storefront route. Keyed by a stable per-product `slug` (the URL param),
-- derived from the angle's hook + id. See docs/brain/specs/advertorial-landers.md.
create table if not exists public.advertorial_pages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  angle_id uuid references public.product_ad_angles(id) on delete set null,
  -- The campaign whose assets (hero, script) seeded this lander.
  campaign_id uuid references public.ad_campaigns(id) on delete set null,

  slug text not null,                              -- URL ?angle={slug}
  variant text not null default 'advertorial',     -- advertorial | beforeafter

  -- Editorial top (generated).
  publication text,                                -- brand-owned masthead
  sponsor_label text default 'SPONSORED',
  headline text,                                   -- editorial serif hero headline
  dek text,                                         -- standfirst
  hero_kind text,                                  -- avatar | ingredient | beforeafter
  hero_storage_path text,                          -- ad-tool bucket path (re-signed at render)
  hero_caption text,
  chapter_heading text,
  chapter_paragraphs jsonb not null default '[]',  -- narrative chapter 1 paragraphs
  sticky_nav jsonb,                                -- optional jump-nav config

  status text not null default 'ready',            -- draft | ready
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, product_id, slug)
);

create index if not exists advertorial_pages_lookup_idx
  on public.advertorial_pages (product_id, slug);
create index if not exists advertorial_pages_angle_idx
  on public.advertorial_pages (angle_id);

alter table public.advertorial_pages enable row level security;

drop policy if exists "Authenticated read advertorial_pages" on public.advertorial_pages;
create policy "Authenticated read advertorial_pages" on public.advertorial_pages
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

drop policy if exists "Service role full on advertorial_pages" on public.advertorial_pages;
create policy "Service role full on advertorial_pages" on public.advertorial_pages
  for all to service_role using (true) with check (true);
