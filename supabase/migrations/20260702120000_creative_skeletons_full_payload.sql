-- Ad Creative Scout — capture the COMPLETE AdLibrary payload per ad (docs/brain/specs/ad-creative-scout.md, Phase 1).
--
-- M2 of the Acquisition Research Engine (docs/brain/goals/acquisition-research-engine.md). Our parser
-- kept ~3 fields; a raw AdLibrary row carries far more — and crucially the ad's DESTINATION
-- (ecom_advertiser_id = the store domain per ad, e.g. shop.ryzesuperfoods.com), full copy, CTA,
-- spend, longevity, and engagement. Capturing all of it is what makes ad-gap analysis (copy/angle/
-- spend/offer) possible AND is the bridge to landing-page-scout (the destination domains are the
-- exact pages competitors spend to drive paid traffic to).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS). Existing creative_skeletons columns already cover
-- advertiser, title, days_running (days_count), heat, first_seen, last_seen, resume_advertising,
-- image_url and raw — this only adds the previously-discarded fields.

-- Destination (the bridge to landing-page-scout) ────────────────────────────────────────────────
-- ecom_advertiser_id: the store domain this specific ad drives traffic to (different ads from one
-- brand hit different landers, so it's the real ad destination, not a homepage guess).
alter table public.creative_skeletons add column if not exists destination_domain text;
alter table public.creative_skeletons add column if not exists has_store_url boolean;

-- Copy + CTA (the angle/offer source for ad-gap analysis) ─────────────────────────────────────────
alter table public.creative_skeletons add column if not exists call_to_action text;
alter table public.creative_skeletons add column if not exists body text;
alter table public.creative_skeletons add column if not exists message text;

-- Spend / scale (winner + offer-pressure signal) ─────────────────────────────────────────────────
alter table public.creative_skeletons add column if not exists estimated_spend numeric;
alter table public.creative_skeletons add column if not exists all_exposure_value numeric;
alter table public.creative_skeletons add column if not exists impression numeric;

-- Engagement ─────────────────────────────────────────────────────────────────────────────────────
alter table public.creative_skeletons add column if not exists like_count integer;
alter table public.creative_skeletons add column if not exists comment_count integer;
alter table public.creative_skeletons add column if not exists share_count integer;
alter table public.creative_skeletons add column if not exists view_count bigint;

-- Channel / type ─────────────────────────────────────────────────────────────────────────────────
alter table public.creative_skeletons add column if not exists platform text;
alter table public.creative_skeletons add column if not exists fb_merge_channel text;
alter table public.creative_skeletons add column if not exists ads_type integer;

-- landing-page-scout reads "the destination domains per approved competitor for this workspace".
create index if not exists creative_skeletons_workspace_destination_idx
  on public.creative_skeletons (workspace_id, destination_domain)
  where destination_domain is not null;
