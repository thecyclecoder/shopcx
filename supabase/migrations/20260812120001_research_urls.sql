-- research_urls: Rhea's URL sensor — one row per distinct ad-scout destination.
--
-- Phase 1 of docs/brain/specs/rhea-url-sensor.md (M1 of the acquisition-research-engine goal).
-- The sensor everything downstream reads: the deterministic sync from the ad scout
-- (creative-finder Inngest sweep) walks creative_skeletons, dedups by normalized URL,
-- counts ads per destination into ad_count, filters obvious junk (linkedin.com etc), and
-- upserts one row per distinct destination as teardown_verdict='unreviewed'. Rhea (Phase 2,
-- box capture+classify) later fills classification + teardown_verdict + rationale.
--
-- North-star (supervisable autonomy): Rhea proposes/classifies; she never acts. This table
-- stores what she saw; a human owner (Growth) reviews the verdicts.
--
-- Chokepoint: all WRITES go through src/lib/research-urls.ts via createAdminClient() (a CI
-- grep enforces no raw .from('research_urls').insert/update outside the SDK).

create table if not exists public.research_urls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- The captured URL and its parsed pieces. `url` is stored NORMALIZED (lower-cased
  -- host, trailing slash preserved, query stripped) — the SDK does the normalization.
  url text not null,
  domain text not null,               -- bare host, e.g. 'learn.erthlabs.co'
  brand text,                          -- creative_skeletons.seed_keyword, best-effort
  competitor_id uuid references public.competitors(id) on delete set null,

  -- Source of the URL. Phase 1 only produces 'ad_scout' (creative_skeletons), but
  -- keep it text so competitor_scout PDPs / our_landers can land later without a
  -- migration bump.
  source text not null default 'ad_scout',

  -- Repetition signal: how many creative_skeletons rows point at this URL.
  ad_count int not null default 0,
  first_seen timestamptz,
  last_seen timestamptz,

  -- Rhea's classification (page_type vocab from src/lib/landing-page-scout.ts, plus
  -- spam / unviewable for the failure cases). Null until Phase 2 fills it.
  classification text
    check (classification in ('advertorial', 'quiz', 'generic_pdp', 'homepage', 'spam', 'unviewable')),

  -- Rhea's teardown verdict + rationale. Every row starts 'unreviewed' at sync time;
  -- Phase 2 flips to worthy | not_worthy with a rationale citing what she saw.
  teardown_verdict text not null default 'unreviewed'
    check (teardown_verdict in ('worthy', 'not_worthy', 'unreviewed')),
  rationale text,

  -- Pointer to the capture bundle (screenshots / chapters). Phase 2 populates this;
  -- Phase 1 always writes null.
  capture_ref text,
  classified_at timestamptz,
  classified_by text,                  -- 'rhea' | operator email — free-text on purpose

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Idempotent upsert key: one row per (workspace, normalized URL).
  unique (workspace_id, url)
);

-- Read-path indexes: browse-by-domain + Rhea's queue-by-verdict.
create index if not exists research_urls_workspace_domain_idx
  on public.research_urls (workspace_id, domain);
create index if not exists research_urls_workspace_verdict_idx
  on public.research_urls (workspace_id, teardown_verdict);

-- updated_at auto-bump on any UPDATE (mirrors ad_spend_budgets / competitors).
create or replace function public.research_urls_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists research_urls_touch_updated_at on public.research_urls;
create trigger research_urls_touch_updated_at
  before update on public.research_urls
  for each row execute function public.research_urls_touch_updated_at();

alter table public.research_urls enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'research_urls' and policyname = 'research_urls_select') then
    create policy research_urls_select on public.research_urls for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'research_urls' and policyname = 'research_urls_service') then
    create policy research_urls_service on public.research_urls for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
