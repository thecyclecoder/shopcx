/**
 * Unit test for the `orders.avalara_doc_code` foreign-app noise-drop predicate
 * (error-feed-drop-orders-avalara-doc-code-adhoc-noise spec). Built-in node:test —
 * no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.orders-avalara-doc-code-noise.test.ts
 *
 * Our `orders` table has NO `avalara_doc_code` column — the Avalara AvaTax document code
 * lives on the tax-transaction ledger, not on our internal `orders` row, and no ShopCX code
 * path selects `orders.avalara_doc_code`. The message surfaces only when a foreign / stale /
 * manual client issues an ad hoc SELECT lookup. Drop AT CAPTURE only when BOTH the exact
 * column-missing message on `orders.avalara_doc_code` AND a SELECT-lookup shape on `orders`
 * (bare OR PostgREST CTE wrapper) are present. A column-missing on a live `orders` column
 * (`order_number`), on a different Avalara column (`avalara_transaction_code`), on
 * `avalara_doc_code` from any other table, or via a non-SELECT statement still pages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingOrdersAvalaraDocCodeColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingOrdersAvalaraDocCodeColumnAdhocNoise drops the canonical message on PostgREST CTE + bare-SELECT shapes", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-missing
  // message on `orders.avalara_doc_code` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAvalaraDocCodeColumnAdhocNoise(
      "column orders.avalara_doc_code does not exist",
      'WITH pgrst_source AS ( SELECT "public"."orders"."id", "public"."orders"."avalara_doc_code" FROM "public"."orders" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAvalaraDocCodeColumnAdhocNoise(
      "column public.orders.avalara_doc_code does not exist",
      'WITH pgrst_source AS (SELECT "public"."orders"."avalara_doc_code" FROM "public"."orders")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAvalaraDocCodeColumnAdhocNoise(
      "column orders.avalara_doc_code does not exist",
      "select id, avalara_doc_code from public.orders",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAvalaraDocCodeColumnAdhocNoise(
      "column orders.avalara_doc_code does not exist",
      "select avalara_doc_code from orders limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAvalaraDocCodeColumnAdhocNoise(
      "ERROR: column orders.avalara_doc_code does not exist",
      'WITH pgrst_source AS (SELECT "public"."orders"."avalara_doc_code" FROM "public"."orders")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingOrdersAvalaraDocCodeColumnAdhocNoise KEEPS different column / other table / non-SELECT / empty query (real regressions still page)", () => {
  // A DIFFERENT Avalara column — `avalara_transaction_code`; the pin is `avalara_doc_code` only.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAvalaraDocCodeColumnAdhocNoise(
      "column orders.avalara_transaction_code does not exist",
      "select avalara_transaction_code from public.orders",
    ),
    false,
  );
  // A live `orders` column — if `order_number` regresses we WANT the page.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAvalaraDocCodeColumnAdhocNoise(
      "column orders.order_number does not exist",
      "select order_number from public.orders",
    ),
    false,
  );
  // `avalara_doc_code` from a DIFFERENT table — not our scoped `orders` noise, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAvalaraDocCodeColumnAdhocNoise(
      "column tax_transactions.avalara_doc_code does not exist",
      "select avalara_doc_code from public.tax_transactions",
    ),
    false,
  );
  // A NON-SELECT statement on orders — real code-bug shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAvalaraDocCodeColumnAdhocNoise(
      "column orders.avalara_doc_code does not exist",
      "insert into public.orders (avalara_doc_code) values ('x')",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAvalaraDocCodeColumnAdhocNoise(
      "column orders.avalara_doc_code does not exist",
      "update public.orders set avalara_doc_code = 'x' where id = 1",
    ),
    false,
  );
  // An empty / missing query attribute — cannot confirm the SELECT-lookup shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersAvalaraDocCodeColumnAdhocNoise(
      "column orders.avalara_doc_code does not exist",
      "",
    ),
    false,
  );
});
