-- creative_test_outcomes — the creative learning flywheel (CEO 2026-07-10). One row per test COMBINATION
-- (angle × treatment) Dahlia generates; the media buyer stamps its outcome (won/lost) once the test
-- concludes. Two jobs:
--   1. Combination-aware exploration — a concept (angle) is only "retired" after MULTIPLE distinct
--      combinations fail (a failed angle×image×audience ≠ a dead angle). Never exclude an angle after one loss.
--   2. Learning — aggregate win-rates per angle_key + per treatment inform which test ads to make FROM THE
--      START (bias toward what's historically won). See docs/brain/libraries/creative-agent + media-buyer-agent.
create table if not exists public.creative_test_outcomes (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  product_id       uuid not null,
  -- The concept identity (normalized angle hook) — the thing we explore/retire at the CONCEPT level.
  angle_key        text not null,
  -- A COMBINATION = the full ad config on top of the concept (CEO): creative × copy × destination. The
  -- SAME concept with a different headline / CTA / image / destination is a NEW combination — so a failed
  -- combination never retires the concept; only many failed combinations do.
  treatment        text not null,      -- creative execution/archetype: before_after|testimonial|big_claim|authority|advertorial
  headline         text,               -- copy: primary headline
  description      text,               -- copy: description / primary text
  cta              text,               -- copy: call-to-action
  destination_url  text,               -- where the ad points (Shopify PDP vs storefront/advertorial variant)
  -- Stable fingerprint of the combination elements — distinct combos share a concept but differ here.
  combination_key  text,
  ad_campaign_id   uuid,               -- the generated combination's campaign (Dahlia)
  meta_adset_id    text,               -- the Meta adset it was tested in (once Bianca launches it)
  -- pending: generated, not yet judged · won: crowned / converting · lost: trimmed · reactivated: recovered
  outcome          text not null default 'pending' check (outcome in ('pending','won','lost','reactivated')),
  -- exploit = a variation of a proven combination; explore = a fresh concept. Drives the 2/2 slot split.
  intent           text not null default 'explore' check (intent in ('explore','exploit')),
  cost_per_atc_cents bigint,
  cpp_cents        bigint,
  spend_cents      bigint,
  decided_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists creative_test_outcomes_product_angle_idx on public.creative_test_outcomes (workspace_id, product_id, angle_key);
create index if not exists creative_test_outcomes_adset_idx on public.creative_test_outcomes (meta_adset_id) where meta_adset_id is not null;
create index if not exists creative_test_outcomes_campaign_idx on public.creative_test_outcomes (ad_campaign_id) where ad_campaign_id is not null;

alter table public.creative_test_outcomes enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='creative_test_outcomes' and policyname='creative_test_outcomes_service_all') then
    create policy creative_test_outcomes_service_all on public.creative_test_outcomes for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='creative_test_outcomes' and policyname='creative_test_outcomes_member_select') then
    create policy creative_test_outcomes_member_select on public.creative_test_outcomes for select to authenticated
      using (exists (select 1 from public.workspace_members m where m.workspace_id = creative_test_outcomes.workspace_id and m.user_id = auth.uid()));
  end if;
end $$;
