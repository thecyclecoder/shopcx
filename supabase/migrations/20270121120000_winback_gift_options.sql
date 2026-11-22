-- Win-back restart: free-gift options the customer picks from on the restart page
-- (CEO 2026-11-21: clear excess inventory by sweetening the restart with a free bag).
-- Read by src/lib/reactivate-journey-builder.ts loadWinbackGifts; the click handler
-- (src/lib/winback-reactivate-choice.ts) honours ONLY a variant on this list and adds it as a
-- one-time $0 line to the first order (subscriptionAddFreeProduct — never recurring).
-- Values are product_variants UUIDs (internal joins use UUIDs; resolved to Shopify ids at call time).
-- Idempotent: re-running overwrites the same key. Scoped to the workspace that owns these variants.
UPDATE journey_definitions jd
SET config = COALESCE(jd.config, '{}'::jsonb) || jsonb_build_object(
      'winback_gifts', jsonb_build_array(
        jsonb_build_object('variant_id', 'e3953a24-c060-41e7-9ca4-06a481df236b', 'label', 'bag of Ashwavana Strawberry'),
        jsonb_build_object('variant_id', 'd9e0362b-5b06-464f-8999-0e96fab85a47', 'label', 'bag of Creatine Prime+ Piña Colada'),
        jsonb_build_object('variant_id', '4c93d134-d0d0-4dff-bb63-4539d41efa6f', 'label', 'bag of Cinnamon Roll Creamer')
      )),
    updated_at = now()
WHERE jd.slug = 'reactivate-subscription'
  AND jd.workspace_id = (SELECT pv.workspace_id FROM product_variants pv WHERE pv.id = 'e3953a24-c060-41e7-9ca4-06a481df236b');
