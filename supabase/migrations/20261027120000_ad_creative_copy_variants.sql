-- ad_creative_copy_variants — one row per (ad_campaign_id, audience_temperature) for a single
-- creative image. Sibling table to public.ad_campaigns (which is 1:1 image:caption today), lets
-- Dahlia's author-session persist THREE temperature-banded variants (cold · warm · hot) against
-- the SAME image + brief so Meta's Advantage+ selector can route each variant to the correct
-- audience (docs/brain/specs/dahlia-temperature-banded-multi-variant-copy-pack.md Phase 1).
--
-- The canonical variant continues to be stamped on ad_campaigns (warm > cold > hot priority)
-- so downstream single-caption readers don't break; this table carries the FULL pack. Phase 2
-- teaches the author session to emit + validate three variants; Phase 1 lands ONLY the storage
-- + the AuthorModeCopy pack shape + the writeCopyVariants SDK chokepoint (per CLAUDE.md's
-- "raw .from() with no SDK → STOP" rule).
--
-- Writers: src/lib/ads/ad-copy-variants.ts `writeCopyVariants` (Phase 1) via createAdminClient
-- (per CLAUDE.md · service-role writes only). Readers: Phase 2's per-variant validator loop +
-- future asset_feed_spec publisher-asset-feed spec that ships the pack to Meta's native
-- multi-variant slot. RLS mirrors ad_creative_copy_qc_verdicts (service-role all writes; any
-- workspace member can select).
--
-- Additive + idempotent (create table IF NOT EXISTS, standard RLS bootstrap).
create table if not exists public.ad_creative_copy_variants (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references public.workspaces(id) on delete cascade,
  ad_campaign_id        uuid not null references public.ad_campaigns(id) on delete cascade,
  -- Which audience band this variant is written FOR. Constrained to the three-band vocabulary
  -- resolveAudienceTemperature emits (cold/warm/hot); the UNIQUE (ad_campaign_id, audience_temperature)
  -- below enforces exactly-one variant per band per creative.
  audience_temperature  text not null check (audience_temperature in ('cold','warm','hot')),
  -- The Meta caption fields — same three strings insertReadyCreative already stamps on ad_campaigns
  -- for the CANONICAL variant, but here for THIS band. Kept as text (not jsonb) so downstream
  -- publisher-asset-feed readers can select without a jsonb->>'text' round-trip.
  headline              text not null,
  primary_text          text not null,
  description           text not null,
  -- Dahlia's self-score against the shared 0-10 Conversion-Psychology rubric. Same shape as
  -- ad_campaigns.author_self_score: { lf8, schwartz, cialdini, hopkins, sugarman, total, evidence[] }.
  -- Nullable because a rare test / deterministic-mode caller may write a variant without a self-score;
  -- the Phase 2 validator loop treats null as no-signal, not as a failure.
  author_self_score     jsonb,
  -- Witnessed-citation entries from the never-fabricate firewall — one per substantive claim in
  -- the caption; each entry names the source field (ingredients / ingredient_research / reviews.byClaim
  -- / transformationStory / supportingBenefit / leadProof / competitorDna) + a source_ref. Nullable
  -- for the same reason as author_self_score (deterministic-mode variants don't emit one).
  claim_trace           jsonb,
  -- Did the M2 shared validator (validateGeneratedCopy) pass every rail for this variant? Phase 2
  -- runs the validator per variant, so a cold variant's cold_offer_gate failure trips ONLY this
  -- band's revise loop — the warm/hot bands still land.
  validator_pass        boolean not null,
  -- The per-check payload from the M2 shared validator: [{ rail, pass, reason? }, ...]. Open
  -- jsonb (no shape CHECK) so a future rail lands without a migration; the .ts parser pins
  -- the shape.
  validator_checks      jsonb not null,
  -- The Andromeda concept tag Dahlia picked for THIS variant. Kept per-variant (not just on the
  -- parent ad_campaigns row) so a cold variant that pivots to a different concept from the warm
  -- one can carry its own tag. Nullable for deterministic-mode / single-variant callers.
  concept_tag           text,
  -- 0 for the first attempt; incremented by the Phase 2 per-variant revise loop up to
  -- MAX_COPY_AUTHOR_REVISE_ATTEMPTS. Bounded by the caller (not a CHECK) so exhaustion is a
  -- director_activity escalation, not a DB error.
  retry_index           int not null default 0,
  created_at            timestamptz not null default now(),
  -- One variant per band per creative. Phase 1's writeCopyVariants uses this as the on-conflict
  -- target so re-writing a pack is idempotent (a Phase 2 revise that lands ONLY the cold band
  -- re-uses this row instead of piling up drafts).
  unique (ad_campaign_id, audience_temperature)
);

-- Per-campaign read: fetch the pack for one creative (the Phase 2 canonical-picker + the
-- future publisher-asset-feed reader).
create index if not exists ad_creative_copy_variants_campaign_idx
  on public.ad_creative_copy_variants (ad_campaign_id);
-- Workspace-wide read: newest-first for the Growth dashboard + measurement queries.
create index if not exists ad_creative_copy_variants_workspace_idx
  on public.ad_creative_copy_variants (workspace_id, created_at desc);

alter table public.ad_creative_copy_variants enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='ad_creative_copy_variants' and policyname='ad_creative_copy_variants_service_all') then
    create policy ad_creative_copy_variants_service_all on public.ad_creative_copy_variants for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='ad_creative_copy_variants' and policyname='ad_creative_copy_variants_member_select') then
    create policy ad_creative_copy_variants_member_select on public.ad_creative_copy_variants for select to authenticated
      using (exists (select 1 from public.workspace_members m where m.workspace_id = ad_creative_copy_variants.workspace_id and m.user_id = auth.uid()));
  end if;
end $$;

comment on table public.ad_creative_copy_variants is
  'Per-creative temperature-banded copy pack (dahlia-temperature-banded-multi-variant-copy-pack Phase 1). One row per (ad_campaign_id, audience_temperature); the ad_campaigns parent still stamps the CANONICAL variant (warm > cold > hot priority) so single-caption readers do not break. Written via writeCopyVariants SDK in src/lib/ads/ad-copy-variants.ts.';
