-- products_bundle_variant_and_coupon — Phase 4 of offer-creator.
--
-- Two new nullable columns on public.products that let a product's bundle PDP
-- point at a specific "bundle variant" (the Starter Kit for Superfoods) and
-- ride an auto-applied coupon code at cart-add time:
--
--   bundle_variant_id  → FK product_variants(id). When ?variant=bundle&name=…
--                        renders the bundle PDP, the Select Bundle CTA adds
--                        THIS variant instead of the base variant. Adding
--                        this variant triggers the offer (Phase 2 attaches
--                        the offer's included physical + digital items).
--   bundle_coupon_code → text (case-preserved). Passed through as
--                        `discount_code` on the cart POST at cart-add time so
--                        the coupon (e.g. a $10 recurring_cycle_limit=1) is
--                        applied to the first order. Null = no coupon.
--
-- Additive, idempotent (IF NOT EXISTS + drop/create FK). No RLS changes
-- (products already has RLS).

alter table public.products
  add column if not exists bundle_variant_id uuid,
  add column if not exists bundle_coupon_code text;

-- Recreate the FK cleanly (drop-then-add so a mid-flight schema drift heals).
alter table public.products
  drop constraint if exists products_bundle_variant_id_fkey;
alter table public.products
  add constraint products_bundle_variant_id_fkey
    foreign key (bundle_variant_id)
    references public.product_variants(id)
    on delete set null;

comment on column public.products.bundle_variant_id is
  'FK product_variants(id). The bundle PDP''s Select Bundle CTA adds this variant instead of the base variant; adding it triggers any offer whose anchor variant_id matches (see docs/brain/tables/offers.md). Phase 4 of offer-creator.';
comment on column public.products.bundle_coupon_code is
  'Auto-applied at bundle cart-add: the Select Bundle CTA passes this as `discount_code` on the /api/cart POST body so the coupon (e.g. a $10 recurring_cycle_limit=1) lands on the first order. Null = no coupon. Phase 4 of offer-creator.';
