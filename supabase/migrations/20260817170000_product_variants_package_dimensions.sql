-- ⭐ CEO 2026-08-17 (#3): store the REAL printed pack size per variant so an ad render reproduces
-- the pouch's true proportions instead of inferring them from a packshot. Observed on ad
-- dcd6d536: our Amazing Coffee pouch rendered visibly narrower than the real pack next to the
-- competitor ad it was imitating.
--
-- Millimetres, nullable: a variant without measured packaging simply emits no dimension clause and
-- renders exactly as it does today. Additive + idempotent — no backfill, no destructive change.
alter table public.product_variants
  add column if not exists package_width_mm  numeric,
  add column if not exists package_height_mm numeric,
  add column if not exists package_depth_mm  numeric;

comment on column public.product_variants.package_width_mm is
  'Real printed pack WIDTH in mm. Fed to the Nano Banana render prompt (creative-generate formatPackageDimensionsClause) so the pouch silhouette matches the physical product. Null = unmeasured, no clause emitted.';
comment on column public.product_variants.package_height_mm is
  'Real printed pack HEIGHT in mm. Paired with width to give the render an exact width:height ratio.';
comment on column public.product_variants.package_depth_mm is
  'Real printed pack DEPTH (gusset) in mm. Optional; informs how much side face is visible in a 3/4 product shot.';
