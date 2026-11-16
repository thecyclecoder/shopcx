/**
 * Unit tests for `isForeignSupabasePostgresMissingReturnsShopifyCustomerIdColumnAdhocNoise` —
 * the capture-time drop for foreign-app noise on Control Tower signature
 * `supabase-logs:ad5b1a7c44ef77c4`. Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.returns-shopify-customer-id-noise.test.ts
 *
 * A foreign / stale direct-REST client still using the old Shopify-era key reads
 * `/rest/v1/returns?...shopify_customer_id=...` against our `public.returns` table. The table
 * was built after Shopify was sunset and keys customers on `customer_id` (uuid) — it never had
 * a `shopify_customer_id` column, and no ShopCX code path filters `returns` by it. Foreign-owned
 * surface, no lever from us — drop AT CAPTURE only when BOTH the exact column-missing message on
 * `returns.shopify_customer_id` AND a SELECT-lookup shape on `returns` (bare OR PostgREST CTE
 * wrapper) are present. A column-missing on a different `returns` column, on
 * `shopify_customer_id` from any other table, or via a non-SELECT statement still pages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingReturnsShopifyCustomerIdColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingReturnsShopifyCustomerIdColumnAdhocNoise drops the captured supabase-logs:ad5b1a7c44ef77c4 message+query pair (PostgREST CTE SELECT on returns.shopify_customer_id)", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-missing
  // message on `returns.shopify_customer_id` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingReturnsShopifyCustomerIdColumnAdhocNoise(
      "column returns.shopify_customer_id does not exist",
      'WITH pgrst_source AS ( SELECT "public"."returns"."id", "public"."returns"."shopify_customer_id" FROM "public"."returns" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingReturnsShopifyCustomerIdColumnAdhocNoise(
      "column public.returns.shopify_customer_id does not exist",
      'WITH pgrst_source AS (SELECT "public"."returns"."shopify_customer_id" FROM "public"."returns")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsShopifyCustomerIdColumnAdhocNoise(
      "column returns.shopify_customer_id does not exist",
      "select id, shopify_customer_id from public.returns",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingReturnsShopifyCustomerIdColumnAdhocNoise(
      "column returns.shopify_customer_id does not exist",
      "select shopify_customer_id from returns limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsShopifyCustomerIdColumnAdhocNoise(
      "ERROR: column returns.shopify_customer_id does not exist",
      'WITH pgrst_source AS (SELECT "public"."returns"."shopify_customer_id" FROM "public"."returns")',
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsShopifyCustomerIdColumnAdhocNoise(
      "column returns.shopify_customer_id does not exist",
      "SELECT ID, SHOPIFY_CUSTOMER_ID FROM PUBLIC.RETURNS",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingReturnsShopifyCustomerIdColumnAdhocNoise KEEPS a column-missing on a different returns column, shopify_customer_id on another table, and a non-SELECT statement (real regressions still page)", () => {
  // A column-missing on a DIFFERENT `returns` column (a real schema regression, including
  // the real `customer_id`) must still page — the pin is a bare `returns.shopify_customer_id`.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsShopifyCustomerIdColumnAdhocNoise(
      "column returns.customer_id does not exist",
      "select customer_id from public.returns",
    ),
    false,
  );
  // A column-missing on `shopify_customer_id` from a DIFFERENT table must still page.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsShopifyCustomerIdColumnAdhocNoise(
      "column orders.shopify_customer_id does not exist",
      "select shopify_customer_id from public.orders",
    ),
    false,
  );
  // A non-SELECT statement against `returns` (real code-bug shape) must still page — the
  // pin is the SELECT-lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsShopifyCustomerIdColumnAdhocNoise(
      "column returns.shopify_customer_id does not exist",
      "update public.returns set shopify_customer_id = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingReturnsShopifyCustomerIdColumnAdhocNoise(
      "column returns.shopify_customer_id does not exist",
      "delete from public.returns where shopify_customer_id is null",
    ),
    false,
  );
  // Empty / absent message or query never drops.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsShopifyCustomerIdColumnAdhocNoise("", "select shopify_customer_id from returns"),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingReturnsShopifyCustomerIdColumnAdhocNoise(
      "column returns.shopify_customer_id does not exist",
      "",
    ),
    false,
  );
});
