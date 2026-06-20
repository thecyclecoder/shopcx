-- Storefront Iteration Engine — Phase 4b: Approval-gated recommendations store.
--
-- The typed, rationale-backed recommendations the decision engine produces for
-- anything that opens a NEW live spend line (new campaign/adset, new benefit
-- angle, new lander variant, offer test). These are NOT autonomous — every row
-- is created `status='pending'` for Dylan to approve/reject; Phase 6b executes
-- approved rows as drafts (PAUSED) and writes external ids back here.
--
-- Agent-legible + typed so the future Growth Director can read/operate it with
-- no migration: each row carries the source scorecard ids it was derived from,
-- the persona that proposed it, expected impact + confidence, and the structured
-- params the Phase 6b adapter needs to act. Written by
-- src/lib/meta/decision-engine.ts (generateRecommendations →
-- meta-decision-engine Inngest). One row per
-- (workspace_id, meta_ad_account_id, snapshot_date, action_type, dedup_key)
-- so a cron re-run never double-recommends.
--
-- Monetary fields are minor units (cents) of the account currency.
-- See docs/brain/specs/storefront-iteration-engine.md (Phase 4b).

create table if not exists public.iteration_recommendations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid not null references public.meta_ad_accounts(id) on delete cascade,

  snapshot_date date not null,                       -- the scorecard day this run reasoned over

  -- ── what to do ───────────────────────────────────────────────────────────────
  action_type text not null check (action_type in (
    'new_static_adset', 'new_video_adset', 'new_campaign',
    'test_benefit_angle', 'new_lander_variant', 'offer_test'
  )),
  status text not null default 'pending' check (status in (
    'pending', 'approved', 'rejected', 'executed', 'failed'
  )),

  -- legibility: which persona proposed this + why
  persona text check (persona in ('direct_response_marketer', 'offer_designer', 'media_buyer')),
  title text,                                        -- short human label
  rationale text not null,                           -- the reasoning (surfaced to Dylan)
  source_metrics jsonb not null default '{}'::jsonb, -- the scorecard numbers cited
  expected_impact text,                              -- the predicted effect, in words
  confidence numeric,                                -- 0..1 model confidence

  -- the target this acts on + the params Phase 6b needs (campaign id, angle id,
  -- variant, benefit anchor, budget, etc.) — structured so the adapter is DB-driven
  target_object_level text check (target_object_level in ('account', 'campaign', 'adset', 'angle', 'variant')),
  target_object_id text,                             -- meta object id | angle uuid | variant slug | null (net-new)
  params jsonb not null default '{}'::jsonb,

  -- traceability: the scorecard rows this recommendation was derived from
  source_scorecard_ids uuid[] not null default '{}',

  -- idempotency: stable hash of (action_type + target + key params) within a day
  dedup_key text not null,

  -- ── review + execution audit ─────────────────────────────────────────────────
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  executed_at timestamptz,
  external_result jsonb,                             -- Phase 6b writes back: { ad_publish_job_id, meta_*_id, ... }

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (workspace_id, meta_ad_account_id, snapshot_date, action_type, dedup_key)
);

create index if not exists iteration_recommendations_account_status_idx
  on public.iteration_recommendations (meta_ad_account_id, status, snapshot_date);
create index if not exists iteration_recommendations_workspace_status_idx
  on public.iteration_recommendations (workspace_id, status, created_at);

-- ── RLS: members read their workspace; service role full ─────────────────────
alter table public.iteration_recommendations enable row level security;

drop policy if exists iteration_recommendations_select on public.iteration_recommendations;
create policy iteration_recommendations_select on public.iteration_recommendations
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
drop policy if exists iteration_recommendations_service on public.iteration_recommendations;
create policy iteration_recommendations_service on public.iteration_recommendations
  for all to service_role using (true) with check (true);
