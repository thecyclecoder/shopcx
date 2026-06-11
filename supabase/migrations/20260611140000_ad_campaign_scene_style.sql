-- Scene style per ad campaign — the setting + action of the shot (kitchen
-- counter, walk & talk, couch, car selfie, desk, …). Drives the holding-product
-- hero image prompt + the Veo talking-head prompt so a single product/avatar can
-- produce a varied ad library instead of the same outdoor-selfie shot every time.
-- Values are defined in src/lib/ad-tool-config.ts (AD_SCENE_STYLES); kept as plain
-- text (not an enum) so new styles ship without a migration.
alter table public.ad_campaigns
  add column if not exists scene_style text not null default 'outdoor_selfie';
