-- Landing Page Scout — per-chapter lander snapshots + gap analysis (docs/brain/specs/landing-page-scout.md, Phase 1).
--
-- M3 of the Acquisition Research Engine. Snapshots competitor landing pages AND ours, mobile,
-- broken into chapters, then vision-analyzes the GAPS → PDP enhancement recommendations that route
-- to Build (a missing component spec) or the storefront-optimizer (a structural experiment).
--
-- Two tables:
--   lander_snapshots        — one row per captured lander (competitor or ours), mobile viewport,
--                             with per-chapter screenshots in `chapters` jsonb. Ours pairs each
--                             chapter with that chapter's funnel stats (dwell %, view→CTA %).
--   lander_recommendations  — one row per vision-identified gap → a supervisable recommendation
--                             (proposed→approved→rejected). On approval it routes to 'build'
--                             (enqueues an agent_jobs build) or 'optimizer' (a storefront_experiments
--                             draft). North-star: the scout proposes WITH evidence; the owner approves.
--
-- Screenshots live in the PRIVATE `lander-shots` Storage bucket (created idempotently by the apply
-- script); the UI reads them through short-lived signed URLs. A competitor lander that fails to load
-- (bot-block) is logged as status='blocked'/'failed', never a hard failure.
--
-- RLS mirrors the competitors / ad-tool tables: workspace-member SELECT, service-role write.

-- ── lander_snapshots ──────────────────────────────────────────────────────────
create table if not exists public.lander_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The product this lander is being compared for (provenance). Nullable for workspace-level.
  product_id uuid references public.products(id) on delete set null,
  -- The competitor this lander belongs to (null when is_ours). ON DELETE SET NULL keeps the snapshot.
  competitor_id uuid references public.competitors(id) on delete set null,

  -- TRUE for our own storefront lander; FALSE for a competitor lander.
  is_ours boolean not null default false,
  -- Display brand handle ('us' for ours, else the competitor brand).
  brand text,
  -- The exact lander URL captured.
  url text not null,
  -- Where the URL came from:
  --   'ad_destination'  — the page a competitor drives PAID traffic to (highest signal; from ad-creative-scout)
  --   'competitor_pdp'  — a canonical PDP/lander URL from competitor-scout (breadth)
  --   'our_lander'      — our own storefront PDP / advertorial lander
  source text not null default 'competitor_pdp'
    check (source in ('ad_destination', 'competitor_pdp', 'our_lander')),

  viewport text not null default 'mobile',
  -- 'captured' | 'blocked' (bot-block / 4xx-5xx) | 'failed' (render/timeout). Blocked/failed are
  -- logged + skipped by the analysis pass, never a hard pipeline failure.
  status text not null default 'captured' check (status in ('captured', 'blocked', 'failed')),

  -- Per-chapter capture. Array of:
  --   { index, label, screenshot_path, dwell_pct?, avg_dwell_ms?, view_to_cta_pct?, reach_sessions? }
  -- For ours, the funnel-stat fields are paired in from storefront_events (StorefrontChapterTracker).
  chapters jsonb not null default '[]'::jsonb,
  -- Bot-block / failure reason (for status in ('blocked','failed')).
  error text,

  captured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lander_snapshots_ws_product_idx
  on public.lander_snapshots (workspace_id, product_id, created_at desc);
create index if not exists lander_snapshots_ws_ours_idx
  on public.lander_snapshots (workspace_id, is_ours, created_at desc);

alter table public.lander_snapshots enable row level security;
drop policy if exists lander_snapshots_select on public.lander_snapshots;
create policy lander_snapshots_select on public.lander_snapshots
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
drop policy if exists lander_snapshots_service on public.lander_snapshots;
create policy lander_snapshots_service on public.lander_snapshots
  for all to service_role using (true) with check (true);

-- ── lander_recommendations ──────────────────────────────────────────────────────
create table if not exists public.lander_recommendations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,

  -- The gap class (e.g. 'comparison_table', 'founder_story', 'ingredient_breakdown',
  -- 'guarantee_badges', 'above_fold_offer', …). Freeform — the vision pass names it.
  gap_type text not null,
  title text not null,
  -- The supervisable evidence sentence ("3 competitors show a comparison table above the fold; we don't").
  rationale text not null,

  -- Where an approved recommendation goes:
  --   'build'     — a missing component → enqueue a Build (mirrors the optimizer's missing-tool→build)
  --   'optimizer' — a structural change we already CAN make → a storefront_experiments draft
  route text not null check (route in ('build', 'optimizer')),
  -- For route='build': the proposed component spec slug the Build session authors.
  target_slug text,

  -- { competitor_snapshot_ids[], competitor_count, our_snapshot_id, examples[] } — the proof shown
  -- to the owner before approval.
  evidence jsonb not null default '{}'::jsonb,

  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  -- What the approval enacted: { agent_job_id } (build) or { experiment_id } (optimizer).
  route_result jsonb,

  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,

  -- Dedup so a re-run doesn't re-propose the same gap. product_id may be null → fold into the key.
  dedup_key text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (workspace_id, dedup_key)
);

create index if not exists lander_recommendations_ws_status_idx
  on public.lander_recommendations (workspace_id, status, created_at desc);
create index if not exists lander_recommendations_ws_product_idx
  on public.lander_recommendations (workspace_id, product_id);

alter table public.lander_recommendations enable row level security;
drop policy if exists lander_recommendations_select on public.lander_recommendations;
create policy lander_recommendations_select on public.lander_recommendations
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
drop policy if exists lander_recommendations_service on public.lander_recommendations;
create policy lander_recommendations_service on public.lander_recommendations
  for all to service_role using (true) with check (true);
