-- always-bin-held-creative-with-flags (CEO 2026-07-21)
-- When Dahlia's copy-author self-heal loop EXHAUSTS on any class (firewall / validator / self-score /
-- Max), the creative is now binned HELD (max_qc_eligible=false, non-postable) instead of discarded, so
-- the CEO can review the near-miss, read what tripped, fix that one line, and approve (override_postable).
-- `hold_flag` carries the red-flag payload the ad detail page renders: { gate, reason, human, attempts }.
-- Open jsonb (no CHECK) so a future gate class lands without a migration; NULL on every postable row.
alter table public.ad_campaigns
  add column if not exists hold_flag jsonb;

comment on column public.ad_campaigns.hold_flag is
  'always-bin-held-creative-with-flags: red-flag payload for a HELD (binned-ineligible) creative — { gate, reason, human, attempts }. NULL on postable rows. Rendered as the "⚠ Held" banner on the ad detail page; written by creative-agent.ts insertReadyCreative via buildAdCampaignInsertBody.';
