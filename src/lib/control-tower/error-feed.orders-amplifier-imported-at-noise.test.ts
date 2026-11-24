/**
 * Unit test for the `orders.amplifier_imported_at` foreign-app noise-drop predicate
 * (error-feed-drop-orders-amplifier-imported-at-adhoc-lookup-noise spec). Built-in
 * node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.orders-amplifier-imported-at-noise.test.ts
 *
 * Our `orders` table has NEVER carried an `amplifier_imported_at` column, and no ShopCX
 * code path selects `orders.amplifier_imported_at`. The message surfaces only when a
 * foreign / stale / manual client issues an ad hoc SELECT lookup. Drop AT CAPTURE only
 * when BOTH the exact column-missing message on `orders.amplifier_imported_at` AND a
 * SELECT-lookup shape on `orders` (bare OR PostgREST CTE wrapper) are present. A
 * column-missing on a live `orders` column (`order_number`), on `amplifier_imported_at`
 * from any other table, or via a non-SELECT statement still pages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingOrdersAmplifierImportedAtAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingOrdersAmplifierImportedAtAdhocNoise drops the canonical message on bare-SELECT + PostgREST CTE shapes", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-missing
  // message on `orders.amplifier_imported_at` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAmplifierImportedAtAdhocNoise(
      "column orders.amplifier_imported_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."orders"."id", "public"."orders"."amplifier_imported_at" FROM "public"."orders" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAmplifierImportedAtAdhocNoise(
      "column public.orders.amplifier_imported_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."orders"."amplifier_imported_at" FROM "public"."orders")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAmplifierImportedAtAdhocNoise(
      "column orders.amplifier_imported_at does not exist",
      "select id, amplifier_imported_at from public.orders",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAmplifierImportedAtAdhocNoise(
      "column orders.amplifier_imported_at does not exist",
      "select amplifier_imported_at from orders limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAmplifierImportedAtAdhocNoise(
      "ERROR: column orders.amplifier_imported_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."orders"."amplifier_imported_at" FROM "public"."orders")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingOrdersAmplifierImportedAtAdhocNoise KEEPS live column / other table / non-SELECT / empty query (real regressions still page)", () => {
  // A DIFFERENT orders column — `order_number` IS a live column; if it regresses we WANT
  // the page. The pin is `amplifier_imported_at` only.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAmplifierImportedAtAdhocNoise(
      "column orders.order_number does not exist",
      "select order_number from public.orders",
    ),
    false,
  );
  // `amplifier_imported_at` from a DIFFERENT table — not our scoped `orders` noise, still
  // pages (a real regression of an `amplifier_imported_at` column on another table).
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAmplifierImportedAtAdhocNoise(
      "column foo.amplifier_imported_at does not exist",
      "select amplifier_imported_at from public.foo",
    ),
    false,
  );
  // A NON-SELECT statement on orders — real code-bug shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAmplifierImportedAtAdhocNoise(
      "column orders.amplifier_imported_at does not exist",
      "update public.orders set amplifier_imported_at = now() where id = 1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAmplifierImportedAtAdhocNoise(
      "column orders.amplifier_imported_at does not exist",
      "delete from public.orders where amplifier_imported_at is null",
    ),
    false,
  );
  // An empty / missing query attribute — cannot confirm the SELECT-lookup shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAmplifierImportedAtAdhocNoise(
      "column orders.amplifier_imported_at does not exist",
      "",
    ),
    false,
  );
});
