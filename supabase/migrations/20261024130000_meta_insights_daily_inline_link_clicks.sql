-- Add Meta's reported INLINE LINK CLICKS to per-object insights (Dahlia M3 measurement lane —
-- docs/brain/specs/dahlia-cold-graded-inline-link-ctr-leading-signal.md Phase 1).
-- inline_link_clicks isolates a click that actually reached the ad's link (landing_url) versus
-- a video-thumb tap, engagement click, or CTA-only click. Meta Ads Manager labels this
-- 'Link Clicks'; the Graph API returns it as `inline_link_clicks` at ad-level insights.
-- Inline-link-CTR = inline_link_clicks/impressions is the leading signal Bianca's grader will
-- use to prove 'author-mode creatives beat deterministic slot-fill on cold audiences' (M3
-- flag-graduation gate for flipping DAHLIA_COPY_MODE).
--
-- NULLABLE-MEANS-UNKNOWN: no default. Old rows stay NULL and per-mode readers EXCLUDE NULLs
-- from CTR numerator/denominator so the pre-migration gap doesn't skew averages (defaulting
-- to 0 would silently pretend those days had 0 link clicks — the exact false-success the M3
-- spec calls out).
alter table public.meta_insights_daily
  add column if not exists inline_link_clicks bigint;

comment on column public.meta_insights_daily.inline_link_clicks is
  'Meta-reported inline link clicks (Graph API `inline_link_clicks`; Meta Ads Manager label ''Link Clicks''). Clicks that reached the ad''s landing_url — excludes video-thumb taps, engagement clicks, and CTA-only clicks. Nullable-means-unknown: pre-migration rows stay NULL and per-mode readers exclude them from the CTR average (never treat NULL as 0). Consumed by the Dahlia M3 leading-signal helper getPerCopyModeCtrCac (docs/brain/specs/dahlia-cold-graded-inline-link-ctr-leading-signal.md).';
