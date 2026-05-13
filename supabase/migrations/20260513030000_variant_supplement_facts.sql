-- Per-variant Supplement Facts panel data. Renders on the storefront
-- as a CSS-styled FDA panel under the FAQ section. Stored on the
-- variant (not the product) because flavor/format variants can have
-- different "Other Ingredients" lines (e.g. Hazelnut adds natural
-- hazelnut flavor + stevia leaf extract).
--
-- Shape — see src/app/(storefront)/_lib/page-data.ts SupplementFacts:
--   {
--     "serving_size": "1 Scoop (8g)",
--     "servings_per_container": 30,
--     "nutrients": [
--       { "name": "Calories", "amount": "20", "daily_value": null, "indent": 0 },
--       { "name": "Total Carbohydrate", "amount": "5 g", "daily_value": "2%*", "indent": 0 },
--       { "name": "Dietary Fiber", "amount": "3 g", "daily_value": "11%*", "indent": 1 },
--       ...
--     ],
--     "proprietary_blend": {
--       "amount": "5.6 g",
--       "daily_value": "**",
--       "ingredients": "French roast coffee (60 mg caffeine), Cocoa, ..."
--     },
--     "footer_notes": ["*Percent Daily Values...", "**Daily value not established."],
--     "other_ingredients": "Fibersol®-2 ..."
--   }

ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS supplement_facts JSONB;
