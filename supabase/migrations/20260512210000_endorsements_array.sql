-- Convert the single-nutritionist endorsement schema (added earlier
-- today in 20260512200000) to an array of endorsements so we can
-- render 3 nutritionist cards side-by-side on the storefront. Each
-- element: { name, title, quote, bullets[] }. Avatars live in
-- product_media at slots `endorsement_1_avatar`, `endorsement_2_avatar`,
-- `endorsement_3_avatar`.

ALTER TABLE product_page_content
  ADD COLUMN IF NOT EXISTS endorsements JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Migrate any data already entered into the singular fields into the
-- first slot of the new array. Safe to run twice — only fires when
-- endorsements is still empty AND any of the legacy fields are set.
UPDATE product_page_content
SET endorsements = jsonb_build_array(
  jsonb_strip_nulls(jsonb_build_object(
    'name', endorsement_name,
    'title', endorsement_title,
    'quote', endorsement_quote,
    'bullets', COALESCE(endorsement_bullets, '[]'::jsonb)
  ))
)
WHERE endorsements = '[]'::jsonb
  AND (
    endorsement_name IS NOT NULL
    OR endorsement_title IS NOT NULL
    OR endorsement_quote IS NOT NULL
    OR (endorsement_bullets IS NOT NULL AND endorsement_bullets <> '[]'::jsonb)
  );

ALTER TABLE product_page_content
  DROP COLUMN IF EXISTS endorsement_name,
  DROP COLUMN IF EXISTS endorsement_title,
  DROP COLUMN IF EXISTS endorsement_quote,
  DROP COLUMN IF EXISTS endorsement_bullets;
