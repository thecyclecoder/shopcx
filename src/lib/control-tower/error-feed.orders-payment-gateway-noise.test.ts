/**
 * Unit test for the `orders.payment_gateway` foreign-app noise-drop predicate
 * (error-feed-drop-orders-payment-gateway-column-adhoc-noise spec). Built-in node:test —
 * no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.orders-payment-gateway-noise.test.ts
 *
 * Our `orders` table has NO `payment_gateway` column — that attribute lives on the Shopify
 * order payload, not on our internal `orders` row, and no ShopCX code path selects
 * `orders.payment_gateway`. The message surfaces only when a foreign / stale / manual client
 * issues an ad hoc SELECT lookup. Drop AT CAPTURE only when BOTH the exact column-missing
 * message on `orders.payment_gateway` AND a SELECT-lookup shape on `orders` (bare OR
 * PostgREST CTE wrapper) are present. A column-missing on a live `orders` column
 * (`financial_status`), on `payment_gateway` from any other table, or via a non-SELECT
 * statement still pages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingOrdersPaymentGatewayColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingOrdersPaymentGatewayColumnAdhocNoise drops the canonical message on bare-SELECT + PostgREST CTE shapes", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-missing
  // message on `orders.payment_gateway` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingOrdersPaymentGatewayColumnAdhocNoise(
      "column orders.payment_gateway does not exist",
      'WITH pgrst_source AS ( SELECT "public"."orders"."id", "public"."orders"."payment_gateway" FROM "public"."orders" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersPaymentGatewayColumnAdhocNoise(
      "column public.orders.payment_gateway does not exist",
      'WITH pgrst_source AS (SELECT "public"."orders"."payment_gateway" FROM "public"."orders")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersPaymentGatewayColumnAdhocNoise(
      "column orders.payment_gateway does not exist",
      "select id, payment_gateway from public.orders",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersPaymentGatewayColumnAdhocNoise(
      "column orders.payment_gateway does not exist",
      "select payment_gateway from orders limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersPaymentGatewayColumnAdhocNoise(
      "ERROR: column orders.payment_gateway does not exist",
      'WITH pgrst_source AS (SELECT "public"."orders"."payment_gateway" FROM "public"."orders")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingOrdersPaymentGatewayColumnAdhocNoise KEEPS live column / other table / non-SELECT / empty query (real regressions still page)", () => {
  // A DIFFERENT orders column — `financial_status` IS a live column; if it regresses we WANT
  // the page. The pin is `payment_gateway` only.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersPaymentGatewayColumnAdhocNoise(
      "column orders.financial_status does not exist",
      "select financial_status from public.orders",
    ),
    false,
  );
  // `payment_gateway` from a DIFFERENT table — not our scoped `orders` noise, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersPaymentGatewayColumnAdhocNoise(
      "column foo.payment_gateway does not exist",
      "select payment_gateway from public.foo",
    ),
    false,
  );
  // A NON-SELECT statement on orders — real code-bug shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersPaymentGatewayColumnAdhocNoise(
      "column orders.payment_gateway does not exist",
      "update public.orders set payment_gateway = 'x' where id = 1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersPaymentGatewayColumnAdhocNoise(
      "column orders.payment_gateway does not exist",
      "delete from public.orders where payment_gateway = 'x'",
    ),
    false,
  );
  // An empty / missing query attribute — cannot confirm the SELECT-lookup shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersPaymentGatewayColumnAdhocNoise(
      "column orders.payment_gateway does not exist",
      "",
    ),
    false,
  );
});
