/**
 * Unit tests for `isForeignSupabasePostgresMissingProductsTemplateSuffixLookupNoise` — the
 * capture-time noise drop for a foreign/stale client that selects the nonexistent
 * `template_suffix` column (a Shopify-native storefront field ShopCX never stores) against
 * `public.products`. Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.products-template-suffix-noise.test.ts
 *
 * The offending read is not ShopCX code (Control Tower signature
 * `supabase-logs:0e3379f172768a91`). Drop AT CAPTURE only when BOTH the exact quoted
 * `column "template_suffix" does not exist` message AND the SELECT-lookup shape on `products`
 * are present. A `template_suffix` error on a different relation, a different missing column
 * on `products`, and a non-SELECT/UPDATE statement still page.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isForeignSupabasePostgresMissingProductsTemplateSuffixLookupNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingProductsTemplateSuffixLookupNoise drops the captured products/template_suffix SELECT shape", () => {
  // The captured incident shape: a Shopify-shaped foreign client lists products selecting the
  // nonexistent template_suffix column, Postgres rejects with the quoted column-missing.
  assert.equal(
    isForeignSupabasePostgresMissingProductsTemplateSuffixLookupNoise(
      'column "template_suffix" does not exist',
      "select handle, template_suffix from products order by handle limit 50",
    ),
    true,
  );
  // The `public.`-qualified FROM variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingProductsTemplateSuffixLookupNoise(
      'column "template_suffix" does not exist',
      "select id, handle, template_suffix from public.products where handle is not null",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingProductsTemplateSuffixLookupNoise(
      'ERROR: column "template_suffix" does not exist',
      "select template_suffix from products",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingProductsTemplateSuffixLookupNoise KEEPS real errors (other table, other column, non-SELECT)", () => {
  // Same template_suffix-missing message on a DIFFERENT relation is a real schema regression
  // and still pages — the pin names products only.
  assert.equal(
    isForeignSupabasePostgresMissingProductsTemplateSuffixLookupNoise(
      'column "template_suffix" does not exist',
      "select id, template_suffix from public.product_media order by id",
    ),
    false,
  );
  // A DIFFERENT missing column on products (a real column rename that broke a live ShopCX
  // query) still pages — the pin is template_suffix only.
  assert.equal(
    isForeignSupabasePostgresMissingProductsTemplateSuffixLookupNoise(
      'column "handle" does not exist',
      "select id, handle from public.products",
    ),
    false,
  );
  // A non-SELECT shape (bare write / DDL) is a real code-bug and still pages.
  assert.equal(
    isForeignSupabasePostgresMissingProductsTemplateSuffixLookupNoise(
      'column "template_suffix" does not exist',
      "update public.products set template_suffix = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductsTemplateSuffixLookupNoise(
      'column "template_suffix" does not exist',
      'insert into public.products ("handle","template_suffix") values ($1,$2)',
    ),
    false,
  );
  // A FATAL / constraint-class error on the same shape is untouched (different message).
  assert.equal(
    isForeignSupabasePostgresMissingProductsTemplateSuffixLookupNoise(
      "FATAL: terminating connection due to administrator command",
      "select handle, template_suffix from products",
    ),
    false,
  );
  // Empty / nullish message or query returns false — we need both markers.
  assert.equal(
    isForeignSupabasePostgresMissingProductsTemplateSuffixLookupNoise("", "select template_suffix from products"),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductsTemplateSuffixLookupNoise('column "template_suffix" does not exist', ""),
    false,
  );
});
