/**
 * Unit tests for `isForeignSupabasePostgresMissingProductVariantsBarcodeAdhocNoise` — the
 * capture-time noise drop for a foreign/stale PostgREST client that selects the nonexistent
 * `product_variants.barcode` column against `public.product_variants`. Built-in node:test — no
 * test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.product-variants-barcode-noise.test.ts
 *
 * ShopCX's `product_variants` schema has never carried a `barcode` column — no migration ever
 * added it and no ShopCX reader selects it. The offending read is not ShopCX code (Control Tower
 * signature `supabase-logs:64cac2882bad75d0`). Drop AT CAPTURE only when BOTH the exact
 * `column product_variants.barcode does not exist` message AND the SELECT-lookup shape on
 * `product_variants` (bare or PostgREST CTE wrapper) are present. A different column on
 * product_variants, a different table, and a non-SELECT statement still page.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isForeignSupabasePostgresMissingProductVariantsBarcodeAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingProductVariantsBarcodeAdhocNoise drops the PostgREST CTE wrapper + bare SELECT listing the non-existent barcode column", () => {
  // The captured incident shape: a stale direct-REST client lists product_variants selecting
  // barcode, PostgREST wraps it as a `WITH pgrst_source AS ( SELECT ... FROM
  // "public"."product_variants" ... )` CTE, and Postgres rejects with the column-missing.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsBarcodeAdhocNoise(
      "column product_variants.barcode does not exist",
      'WITH pgrst_source AS ( SELECT "public"."product_variants"."id", "public"."product_variants"."sku", "public"."product_variants"."barcode" FROM "public"."product_variants" ORDER BY "public"."product_variants"."id" DESC LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsBarcodeAdhocNoise(
      "column public.product_variants.barcode does not exist",
      'with pgrst_source as ( select "public"."product_variants"."barcode" from "public"."product_variants" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsBarcodeAdhocNoise(
      "ERROR: column product_variants.barcode does not exist",
      'WITH pgrst_source AS ( SELECT "barcode" FROM "public"."product_variants" )',
    ),
    true,
  );
  // The bare SELECT form (not a PostgREST wrapper), qualified and unqualified FROM, drops.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsBarcodeAdhocNoise(
      "column product_variants.barcode does not exist",
      "select id, barcode from public.product_variants order by id desc limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsBarcodeAdhocNoise(
      "column product_variants.barcode does not exist",
      "select * from product_variants where barcode is not null",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingProductVariantsBarcodeAdhocNoise KEEPS real errors (other column, other table, non-SELECT)", () => {
  // A DIFFERENT column on product_variants (e.g. a real column rename that broke a live query)
  // still pages — the pin is barcode only.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsBarcodeAdhocNoise(
      "column product_variants.sku does not exist",
      "select id, sku from public.product_variants",
    ),
    false,
  );
  // Same barcode-missing message on a DIFFERENT relation is a real product-schema regression
  // and still pages — the pin names product_variants only.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsBarcodeAdhocNoise(
      "column products.barcode does not exist",
      "select id, barcode from public.products order by id desc",
    ),
    false,
  );
  // A non-SELECT shape (PostgREST CTE write / bare write) is a real code-bug and still pages.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsBarcodeAdhocNoise(
      "column product_variants.barcode does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."product_variants"("id","barcode") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsBarcodeAdhocNoise(
      "column product_variants.barcode does not exist",
      "update public.product_variants set barcode = $1 where id = $2",
    ),
    false,
  );
  // A FATAL / constraint-class error on the same shape is untouched (different message).
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsBarcodeAdhocNoise(
      "FATAL: terminating connection due to administrator command",
      "select id, barcode from public.product_variants",
    ),
    false,
  );
  // Empty / nullish message or query returns false — we need both markers.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsBarcodeAdhocNoise("", "select * from product_variants"),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsBarcodeAdhocNoise(
      "column product_variants.barcode does not exist",
      "",
    ),
    false,
  );
});
