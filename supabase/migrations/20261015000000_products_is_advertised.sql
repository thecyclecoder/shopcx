-- products.is_advertised — hero-product advertising gate (docs/brain/specs/hero-product-advertising-gate.md Phase 1).
--
-- ShopCX auto-enumerates ALL products in advertising pipelines (DR-content / Dahlia creative /
-- product angle-gen / media-buyer fan-out), but only 6 hero SKUs are actually advertised. Every
-- other product is an attachment SKU (Sleep Gummies, Superfoods Tumbler, Handheld Drink Mixer,
-- Bamboo Coffee Mug, …). Before this flag, nothing structurally distinguished a hero from an
-- attachment SKU — Carrie's DR-content lane generated content for Tumbler + Sleep Gummies
-- (parked + CEO-dismissed 2026-07-11), and Dahlia/research would do the same.
--
-- This migration is additive + idempotent (ADD COLUMN IF NOT EXISTS + UPDATE by title — re-running
-- is a no-op). The Phase-1 helper in src/lib/advertised-products.ts is the single source of truth
-- the Phase-2 gates read.
alter table public.products
  add column if not exists is_advertised boolean not null default false;

comment on column public.products.is_advertised is
  'True for hero products the workspace actively advertises. Read by src/lib/advertised-products.ts (isAdvertisedProduct / listAdvertisedProductIds) to gate every ad/DR/creative enumeration. Attachment SKUs stay false.';

-- Seed the 6 named hero products (Superfoods Co). Titles are unique per workspace on the live
-- Superfoods storefront, so a title-only match is safe — attachment SKUs stay false. A second
-- workspace that happens to share a title would also flip, which is desirable (any workspace
-- naming a product "Superfood Tabs" wants it advertised).
update public.products
   set is_advertised = true
 where title in (
   'Superfood Tabs',
   'Amazing Coffee',
   'Amazing Creamer',
   'Ashwavana Guru Focus',
   'Ashwavana Zen Relax',
   'Creatine Prime+'
 );
