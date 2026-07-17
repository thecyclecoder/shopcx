-- ad_campaigns.audience_temperature — Dahlia audience-temperature marking (docs/brain/specs/dahlia-audience-temperature-marking-and-cold-offer-gate.md Phase 1).
--
-- Under Advantage+ the creative IS the audience selector, so recording which temperature
-- band (cold / warm / hot) a creative was written for is a first-class schema concern.
-- Dahlia's M1 keystone author session tags this per creative; the M3 variant-pack spec
-- writes three temperature-banded variants against the same column; the Phase-2 gate in
-- src/lib/ads/creative-agent.ts insertReadyCreative reads it to refuse a cold-tagged
-- creative whose caption leaks LF8 offer/urgency language.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS, no backfill). Existing rows remain
-- NULL, which is interpreted as "untagged" — deterministic buildMetaCopy inserts and
-- pre-Dahlia campaigns pass through the Phase-2 gate untouched. No index: the column is
-- a per-row read at insert time, not a query filter.
alter table public.ad_campaigns
  add column if not exists audience_temperature text
    check (audience_temperature is null or audience_temperature in ('cold','warm','hot'));

comment on column public.ad_campaigns.audience_temperature is
  'Temperature band the creative was authored for: cold | warm | hot, or NULL (untagged). Dahlia tags on author-mode inserts; deterministic buildMetaCopy leaves it NULL. Read by insertReadyCreative in src/lib/ads/creative-agent.ts — a cold row whose composed copy trips hasColdOfferLeak (src/lib/ads/lf8.ts) is refused at status=ready.';
