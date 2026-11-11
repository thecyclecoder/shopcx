/**
 * Unit test for the `replacements.shopify_order_id` foreign-app noise-drop predicate
 * (error-feed-drop-replacements-shopify-order-id-direct-rest-noise spec). Built-in
 * node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.replacements-shopify-order-id-noise.test.ts
 *
 * Our `replacements` table exists but has NEVER carried a `shopify_order_id` column —
 * internal joins key on UUIDs and Shopify is being sunset, so no ShopCX code path selects
 * `replacements.shopify_order_id`. The message surfaces only when a foreign / stale /
 * manual client issues an ad hoc SELECT lookup. Drop AT CAPTURE only when BOTH the exact
 * column-missing message on `replacements.shopify_order_id` AND a SELECT-lookup shape on
 * `replacements` (bare OR PostgREST CTE wrapper) are present. A column-missing on a
 * different `replacements` column, on `shopify_order_id` from any other table, or via a
 * non-SELECT statement still pages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingReplacementsShopifyOrderIdDirectRestNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingReplacementsShopifyOrderIdDirectRestNoise drops the captured PostgREST-wrapped + bare-SELECT samples", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-missing
  // message on `replacements.shopify_order_id` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingReplacementsShopifyOrderIdDirectRestNoise(
      "column replacements.shopify_order_id does not exist",
      'WITH pgrst_source AS ( SELECT "public"."replacements"."id", "public"."replacements"."shopify_order_id" FROM "public"."replacements" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingReplacementsShopifyOrderIdDirectRestNoise(
      "column public.replacements.shopify_order_id does not exist",
      'WITH pgrst_source AS (SELECT "public"."replacements"."shopify_order_id" FROM "public"."replacements")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingReplacementsShopifyOrderIdDirectRestNoise(
      "column replacements.shopify_order_id does not exist",
      "select id, shopify_order_id from public.replacements",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingReplacementsShopifyOrderIdDirectRestNoise(
      "column replacements.shopify_order_id does not exist",
      "select shopify_order_id from replacements limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingReplacementsShopifyOrderIdDirectRestNoise(
      "ERROR: column replacements.shopify_order_id does not exist",
      'WITH pgrst_source AS (SELECT "public"."replacements"."shopify_order_id" FROM "public"."replacements")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingReplacementsShopifyOrderIdDirectRestNoise KEEPS a DIFFERENT column on replacements (real rename regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingReplacementsShopifyOrderIdDirectRestNoise(
      "column replacements.order_id does not exist",
      "select order_id from public.replacements",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingReplacementsShopifyOrderIdDirectRestNoise KEEPS a shopify_order_id error on ANOTHER table (real regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingReplacementsShopifyOrderIdDirectRestNoise(
      "column orders.shopify_order_id does not exist",
      "select shopify_order_id from public.orders",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingReplacementsShopifyOrderIdDirectRestNoise KEEPS a non-SELECT statement / empty query (real code-bug shape still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingReplacementsShopifyOrderIdDirectRestNoise(
      "column replacements.shopify_order_id does not exist",
      "update public.replacements set shopify_order_id = 'x' where id = 1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingReplacementsShopifyOrderIdDirectRestNoise(
      "column replacements.shopify_order_id does not exist",
      "delete from public.replacements where shopify_order_id = 'x'",
    ),
    false,
  );
  // Empty / missing query attribute — cannot confirm the SELECT-lookup shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingReplacementsShopifyOrderIdDirectRestNoise(
      "column replacements.shopify_order_id does not exist",
      "",
    ),
    false,
  );
  // Empty / nullish message — need both markers.
  assert.equal(
    isForeignSupabasePostgresMissingReplacementsShopifyOrderIdDirectRestNoise(null, null),
    false,
  );
});
