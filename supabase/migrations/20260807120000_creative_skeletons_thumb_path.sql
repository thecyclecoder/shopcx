-- creative_skeletons.thumb_path — the storage path (in the private `creative-shots` bucket) of a
-- downscaled, analyzable copy of the ad creative that WE host, so the dashboard serves our own version
-- instead of live-proxying AdLibrary's full-res source on every image load (that 502'd: 6-22MB fetch
-- per request through a serverless function). Populated by creative-skeleton.ingestAd; served as a
-- signed URL by the creative-finder list route. NULL for legacy rows (they fall back to the proxy).
alter table public.creative_skeletons add column if not exists thumb_path text;
