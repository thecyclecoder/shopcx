-- Winning Static-Creative Finder — Phase 1: the skeleton store.
--
-- One row per analyzed competitor/category winner pulled from AdLibrary.com. We
-- store the reverse-engineered STRUCTURE (hook → mechanism claim → proof → offer)
-- + a link to the creative for analysis — NEVER a lifted asset. The signal we mine
-- is repetition of a slot across multiple INDEPENDENT brands, so `advertiser`
-- (the brand) + the four slots are the load-bearing columns; the pattern matrix
-- (Phase 4) aggregates over them. See docs/brain/specs/winning-static-creative-finder.md.
--
-- Dedup is by AdLibrary's `ad_key` (stored as `dedup_key`) per workspace+source so
-- we never re-vision/re-spend on the same creative. Statics are visioned at
-- ingestion (status='analyzed'); videos are routed aside (status='video_pending')
-- for the heavier Phase 6 frame+transcript pipeline.

create table if not exists public.creative_skeletons (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  source text not null default 'adlibrary',        -- where the creative came from
  dedup_key text not null,                          -- AdLibrary `ad_key` (idempotency key)
  advertiser text,                                  -- the brand (the unit of "independent")
  title text,                                       -- AdLibrary `title` (often thin)
  image_url text,                                   -- stored/original creative link (analysis only)
  media_type text not null default 'static',        -- 'static' | 'video' (routed at ingestion)

  -- The reverse-engineered skeleton (extracted by vision, Phase 3).
  format text,                                      -- ugc | studio | text-card | before_after | demo | ...
  framework text,                                   -- hook-promise-proof | problem-pivot-payoff | ...
  hook text,                                        -- slot 1
  mechanism_claim text,                             -- slot 2
  proof text,                                       -- slot 3
  offer text,                                       -- slot 4

  -- Longevity + scale signals from AdLibrary (long-runners = proven winners).
  days_running int,                                 -- `days_count`
  heat numeric,                                     -- `heat` / exposure score
  first_seen date,                                  -- `first_seen`
  last_seen date,                                   -- `last_seen`
  resume_advertising boolean,                       -- `resume_advertising_flag`

  -- Provenance of the pull.
  seed_keyword text,                                -- the query that surfaced this ad
  seed_kind text,                                   -- 'category' | 'competitor'

  status text not null default 'analyzed'
    check (status in ('pending', 'analyzed', 'video_pending', 'shortlisted', 'archived', 'failed')),
  raw jsonb,                                        -- full AdLibrary row for replay
  visioned_at timestamptz,                          -- when the skeleton was extracted

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, source, dedup_key)
);

create index if not exists creative_skeletons_workspace_status_idx
  on public.creative_skeletons (workspace_id, status);
create index if not exists creative_skeletons_advertiser_idx
  on public.creative_skeletons (workspace_id, advertiser);
create index if not exists creative_skeletons_days_running_idx
  on public.creative_skeletons (workspace_id, days_running desc);

-- ── RLS: members read their workspace; service role full ─────────────────────
alter table public.creative_skeletons enable row level security;

drop policy if exists creative_skeletons_select on public.creative_skeletons;
create policy creative_skeletons_select on public.creative_skeletons
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

drop policy if exists creative_skeletons_service on public.creative_skeletons;
create policy creative_skeletons_service on public.creative_skeletons
  for all to service_role using (true) with check (true);

comment on table public.creative_skeletons is
  'Reverse-engineered STRUCTURE of winning competitor/category ads (hook/mechanism/proof/offer skeleton + creative link), pulled from AdLibrary.com and deconstructed by vision. Structure + link only, never a lifted asset. The cross-brand-repetition signal feeds the Phase 4 pattern matrix. See docs/brain/specs/winning-static-creative-finder.md.';
