/**
 * Unit test for the `customer_payment_methods.card_last4` foreign-app noise-drop predicate
 * (error-feed-drop-customer-payment-methods-card-last4-adhoc-noise spec). Built-in node:test —
 * no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.customer-payment-methods-card-last4-noise.test.ts
 *
 * Our `customer_payment_methods` table has NO `card_last4` column — the real column is `last4`.
 * A foreign / stale PostgREST client read it with a display-column schema (`card_type`,
 * `card_last4`, ...) the table never carried, and no ShopCX code path selects
 * `customer_payment_methods.card_last4`. The message surfaces only when that foreign client
 * issues an ad hoc SELECT lookup (Control Tower signature supabase-logs:9fd54dc64ce14fc0).
 * Drop AT CAPTURE only when BOTH the exact column-missing message on
 * `customer_payment_methods.card_last4` AND a SELECT-lookup shape on
 * `customer_payment_methods` (bare OR PostgREST CTE wrapper) are present. A column-missing on a
 * DIFFERENT `customer_payment_methods` column, on `card_last4` from any other table, or via a
 * non-SELECT statement still pages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingCustomerPaymentMethodsCardLast4ColumnNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingCustomerPaymentMethodsCardLast4ColumnNoise drops the canonical message on bare-SELECT + PostgREST CTE shapes", () => {
  // The captured production sample (signature supabase-logs:9fd54dc64ce14fc0):
  // PostgREST-wrapped SELECT + the exact column-missing message on
  // `customer_payment_methods.card_last4` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingCustomerPaymentMethodsCardLast4ColumnNoise(
      "column customer_payment_methods.card_last4 does not exist",
      'WITH pgrst_source AS ( SELECT "public"."customer_payment_methods"."id", "public"."customer_payment_methods"."card_last4" FROM "public"."customer_payment_methods" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomerPaymentMethodsCardLast4ColumnNoise(
      "column public.customer_payment_methods.card_last4 does not exist",
      'WITH pgrst_source AS (SELECT "public"."customer_payment_methods"."card_last4" FROM "public"."customer_payment_methods")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerPaymentMethodsCardLast4ColumnNoise(
      "column customer_payment_methods.card_last4 does not exist",
      "select id, card_last4 from public.customer_payment_methods",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomerPaymentMethodsCardLast4ColumnNoise(
      "column customer_payment_methods.card_last4 does not exist",
      "select card_last4 from customer_payment_methods limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerPaymentMethodsCardLast4ColumnNoise(
      "ERROR: column customer_payment_methods.card_last4 does not exist",
      'WITH pgrst_source AS (SELECT "public"."customer_payment_methods"."card_last4" FROM "public"."customer_payment_methods")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingCustomerPaymentMethodsCardLast4ColumnNoise KEEPS other columns / other tables / non-SELECT shapes / empty query (real regressions still page)", () => {
  // A DIFFERENT customer_payment_methods column — `last4` IS the real live column; if it
  // regresses we WANT the page. The pin is `card_last4` only.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerPaymentMethodsCardLast4ColumnNoise(
      "column customer_payment_methods.last4 does not exist",
      "select last4 from public.customer_payment_methods",
    ),
    false,
  );
  // `card_last4` on ANOTHER table — the pin is `customer_payment_methods` only.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerPaymentMethodsCardLast4ColumnNoise(
      "column orders.card_last4 does not exist",
      "select card_last4 from public.orders",
    ),
    false,
  );
  // A NON-SELECT statement on customer_payment_methods — real code-bug shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerPaymentMethodsCardLast4ColumnNoise(
      "column customer_payment_methods.card_last4 does not exist",
      "delete from public.customer_payment_methods where card_last4 = '1234'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomerPaymentMethodsCardLast4ColumnNoise(
      "column customer_payment_methods.card_last4 does not exist",
      "update public.customer_payment_methods set card_last4 = '1234' where id = 1",
    ),
    false,
  );
  // An empty / missing query attribute — cannot confirm the SELECT-lookup shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerPaymentMethodsCardLast4ColumnNoise(
      "column customer_payment_methods.card_last4 does not exist",
      "",
    ),
    false,
  );
  // Empty / nullish message — cannot confirm the column-missing shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerPaymentMethodsCardLast4ColumnNoise(
      "",
      "select card_last4 from customer_payment_methods",
    ),
    false,
  );
});
