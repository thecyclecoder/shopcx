-- Ad-gap recommendations — the persisted, trackable queue for the Ad Creative Scout's gaps
-- (docs/brain/specs/acquisition-research-hub.md, Phase 1; M4 of the Acquisition Research Engine).
--
-- The ad-gap layer (src/lib/ad-gap.ts buildAdGapReport) computes "competitor angles we don't run"
-- DETERMINISTICALLY ON DEMAND — it has never been persisted, so an ad gap could not be approved,
-- routed, or tracked through to shipped/won. This table is the ad-side mirror of lander_recommendations
-- (the Landing Page Scout's queue): the Acquisition Research Hub MATERIALIZES each surfaced ad gap here
-- (idempotent on dedup_key, always as status='proposed'), and the owner approves → it routes to Build
-- (an ad-creative iteration), exactly like a lander gap routes to Build/optimizer. Together the two
-- tables are the hub's unified gap queue.
--
-- North-star: rows land 'proposed' WITH evidence; nothing routes until the owner approves. Ad gaps are
-- angle-clustered at the WORKSPACE level (not per-product) — buildAdGapReport reasons over the whole
-- creative_skeletons corpus — so product_id is nullable here (unlike lander_recommendations).
--
-- RLS mirrors competitors / lander_recommendations: workspace-member SELECT, service-role write.

create table if not exists public.ad_gap_recommendations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Ad gaps are workspace-level (angle clusters across competitors), so product is informational/nullable.
  product_id uuid references public.products(id) on delete set null,

  -- The gap class. 'ad_angle' in Phase 1 (buildAdGapReport keys gaps on the angle).
  gap_type text not null default 'ad_angle',
  -- The competitor angle label we don't run.
  title text not null,
  -- The supervisable recommendation sentence ("4 brands run a 'no jitters' energy angle for 90+ days; we don't").
  rationale text not null,

  -- Where an approved ad gap goes. Ad gaps route to 'build' (an ad-creative iteration via the ad
  -- iteration engine); 'optimizer' is allowed for forward-symmetry with lander_recommendations.
  route text not null default 'build' check (route in ('build', 'optimizer')),
  -- For route='build': the proposed ad-iteration spec slug the Build session authors.
  target_slug text,

  -- The proof shown before approval: { brandCount, brands[], maxDaysRunning, totalEstimatedSpend,
  -- formats[], offers[], ctas[], ads[] } — straight off the AdGapRecommendation.
  evidence jsonb not null default '{}'::jsonb,

  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  -- What approval enacted: { agent_job_id, spec_slug } (build) or { experiment_id } (optimizer).
  route_result jsonb,

  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,

  -- Dedup so re-materializing the (deterministic) ad-gap report never re-proposes the same angle.
  dedup_key text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (workspace_id, dedup_key)
);

create index if not exists ad_gap_recommendations_ws_status_idx
  on public.ad_gap_recommendations (workspace_id, status, created_at desc);

alter table public.ad_gap_recommendations enable row level security;
drop policy if exists ad_gap_recommendations_select on public.ad_gap_recommendations;
create policy ad_gap_recommendations_select on public.ad_gap_recommendations
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
drop policy if exists ad_gap_recommendations_service on public.ad_gap_recommendations;
create policy ad_gap_recommendations_service on public.ad_gap_recommendations
  for all to service_role using (true) with check (true);
