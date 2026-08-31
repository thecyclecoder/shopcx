-- Variant-scoped review hero imagery (review-journey polish).
--
-- The review journey was showing `products.image_url` — the PDP hero, a
-- packshot. That image sells "what am I buying"; this page needs "remember why
-- you love this". And it has to be per-VARIANT, because flavours are different
-- colours: Creatine Prime+ Black Cherry is a deep red glass, Pina Colada is a
-- creamy tropical one. A generic product shot is wrong for at least one of them
-- by construction.
--
-- 1. product_media.variant_id — nullable, so every existing product-scoped row
--    (hero, press_*, ingredient_*, timeline_*) keeps working untouched. Storing
--    these in product_media rather than a URL column on product_variants is
--    deliberate: product_media already generates the full responsive set
--    (avif/webp at 480/750/1080/1500/1920), and this image is the hero of a
--    page opened almost entirely on phones from an SMS link.
--
-- 2. journey_sessions.variant_id — so the journey can show the flavour the
--    customer ACTUALLY bought, resolved from the order line. Same hand-picked
--    principle as the tenure fact: specific to them, and checkable.
--
-- Resolution order in the handler: variant review_hero → product review_hero →
-- products.image_url. Never breaks mid-rollout; degrades to today's behaviour.
--
-- Additive + idempotent. No DROPs.

ALTER TABLE public.product_media
  ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES public.product_variants(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.product_media.variant_id IS
  'Variant this asset belongs to. NULL = product-scoped (the default for every pre-existing slot). Set for per-flavour assets like the review_hero, where colour differs by variant.';

CREATE INDEX IF NOT EXISTS product_media_variant_slot_idx
  ON public.product_media (variant_id, slot) WHERE variant_id IS NOT NULL;

ALTER TABLE public.journey_sessions
  ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES public.product_variants(id);

COMMENT ON COLUMN public.journey_sessions.variant_id IS
  'Variant the review ask is about, resolved from the customer''s order line — so the journey shows the flavour they actually bought. Nullable; the handler falls back to product-scoped imagery.';
