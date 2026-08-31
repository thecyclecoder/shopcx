-- Seed the product-review journey definition (review-collection-foundations gap fix).
--
-- Phase 3 of review-collection-foundations shipped the HANDLER
-- (src/lib/portal/handlers/review-journey.ts) but never created the
-- journey_definitions row it renders. Journeys are DB-driven (CLAUDE.md:
-- "Journeys + cancel-flow + remedies + coupon mappings: all DB-driven, never
-- hardcoded"), so without this row no session can be created, config_snapshot
-- has no question set to freeze, and the handler is unreachable code. The
-- phase's machine checks only grepped for code existence, which is why it
-- passed while being functionally incomplete.
--
-- `config` holds the per-product slider question sets. The DEFAULT set is the
-- one the retired Klaviyo review flow used. Flavor is deliberately absent from
-- the accessory set — asking how a Tumbler tastes is the kind of question that
-- makes the whole message read as automated.
--
-- Scales are 1-5 except `expectation`, which is the 3-anchor scale Klaviyo used
-- ("Did Not Meet · What I Expected · Exceeded Expectations"). The handler
-- snapshots whichever set applies into journey_sessions.config_snapshot at
-- session creation, so editing this row can never corrupt an in-flight session.
--
-- Idempotent: NOT EXISTS guard per workspace, matching the add-payment-method
-- seed's shape (20260707000000_seed_add_payment_method_journey.sql).

INSERT INTO journey_definitions (
  workspace_id, slug, name, journey_type, trigger_intent, description,
  config, channels, is_active, priority
)
SELECT
  w.id,
  'product-review',
  'Product Review',
  'custom',
  'product_review',
  'Tokenized product-review collection: product image, 5-star, per-product slider questions, and a comment seeded from the slider answers. Submitting writes product_reviews (with attribute_scores), mints a customer-scoped reward regardless of rating, and routes 1-3 star to CS instead of publishing.',
  jsonb_build_object(
    'steps', jsonb_build_array('rating', 'attributes', 'comment'),
    'comment_min_chars', 15,
    'reward', jsonb_build_object('amount', 10, 'code_prefix', 'REVIEW', 'expiry_days', 30),
    'publish_threshold', 4,
    'question_sets', jsonb_build_object(
      'default', jsonb_build_array(
        jsonb_build_object('key','convenience','label','Convenience','type','slider','min_label','Not Convenient','max_label','Very Convenient','required',true),
        jsonb_build_object('key','effectiveness','label','Effectiveness','type','slider','min_label','Not Effective','max_label','Very Effective','required',true),
        jsonb_build_object('key','flavor','label','Flavor','type','slider','min_label','I Don''t Like It','max_label','I Love It','required',true),
        jsonb_build_object('key','expectation','label','Overall Expectation','type','scale3','labels',jsonb_build_array('Did Not Meet','What I Expected','Exceeded Expectations'),'required',true)
      ),
      'accessory', jsonb_build_array(
        jsonb_build_object('key','convenience','label','Convenience','type','slider','min_label','Not Convenient','max_label','Very Convenient','required',true),
        jsonb_build_object('key','effectiveness','label','Effectiveness','type','slider','min_label','Not Effective','max_label','Very Effective','required',true),
        jsonb_build_object('key','expectation','label','Overall Expectation','type','scale3','labels',jsonb_build_array('Did Not Meet','What I Expected','Exceeded Expectations'),'required',true)
      )
    ),
    'accessory_handles', jsonb_build_array('tumbler','mixer','mug')
  ),
  ARRAY['email', 'sms', 'portal', 'chat'],
  true,
  40
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM journey_definitions jd
  WHERE jd.workspace_id = w.id AND jd.slug = 'product-review'
);
