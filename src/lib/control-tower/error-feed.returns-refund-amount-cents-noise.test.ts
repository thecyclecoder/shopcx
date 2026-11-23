/**
 * Unit tests for `isForeignSupabasePostgresMissingReturnsRefundAmountCentsColumnAdhocNoise` —
 * the capture-time drop for foreign-app noise on Control Tower signature
 * `supabase-logs:79ffb1a222c7d69e`. Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.returns-refund-amount-cents-noise.test.ts
 *
 * A foreign / stale PostgREST direct-REST client reads
 * `/rest/v1/returns?select=...refund_amount_cents...` against our `public.returns` table with a
 * guessed, wrong column list. The table stores the refunded amount in `net_refund_cents`, never
 * a bare `refund_amount_cents`, and no ShopCX code path names it. Foreign-owned surface, no
 * lever from us — drop AT CAPTURE only when BOTH the exact column-missing message on
 * `returns.refund_amount_cents` AND a SELECT-lookup shape on `returns` (bare OR PostgREST CTE
 * wrapper) are present. A column-missing on a different `returns` column, on
 * `refund_amount_cents` from any other table, or via a non-SELECT statement still pages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingReturnsRefundAmountCentsColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingReturnsRefundAmountCentsColumnAdhocNoise drops the captured supabase-logs:79ffb1a222c7d69e message+query pair (PostgREST CTE SELECT on returns.refund_amount_cents)", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-missing
  // message on `returns.refund_amount_cents` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingReturnsRefundAmountCentsColumnAdhocNoise(
      "column returns.refund_amount_cents does not exist",
      'WITH pgrst_source AS ( SELECT "public"."returns"."id", "public"."returns"."refund_amount_cents" FROM "public"."returns" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingReturnsRefundAmountCentsColumnAdhocNoise(
      "column public.returns.refund_amount_cents does not exist",
      'WITH pgrst_source AS (SELECT "public"."returns"."refund_amount_cents" FROM "public"."returns")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsRefundAmountCentsColumnAdhocNoise(
      "column returns.refund_amount_cents does not exist",
      "select id, refund_amount_cents from public.returns",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingReturnsRefundAmountCentsColumnAdhocNoise(
      "column returns.refund_amount_cents does not exist",
      "select refund_amount_cents from returns limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsRefundAmountCentsColumnAdhocNoise(
      "ERROR: column returns.refund_amount_cents does not exist",
      'WITH pgrst_source AS (SELECT "public"."returns"."refund_amount_cents" FROM "public"."returns")',
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsRefundAmountCentsColumnAdhocNoise(
      "column returns.refund_amount_cents does not exist",
      "SELECT ID, REFUND_AMOUNT_CENTS FROM PUBLIC.RETURNS",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingReturnsRefundAmountCentsColumnAdhocNoise KEEPS a column-missing on a different returns column, refund_amount_cents on another table, and a non-SELECT statement (real regressions still page)", () => {
  // A column-missing on a DIFFERENT `returns` column (a real schema regression, including
  // the real `net_refund_cents`) must still page — the pin is a bare `returns.refund_amount_cents`.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsRefundAmountCentsColumnAdhocNoise(
      "column returns.net_refund_cents does not exist",
      "select net_refund_cents from public.returns",
    ),
    false,
  );
  // A column-missing on `refund_amount_cents` from a DIFFERENT table must still page.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsRefundAmountCentsColumnAdhocNoise(
      "column order_refunds.refund_amount_cents does not exist",
      "select refund_amount_cents from public.order_refunds",
    ),
    false,
  );
  // A non-SELECT statement against `returns` (real code-bug shape) must still page — the
  // pin is the SELECT-lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsRefundAmountCentsColumnAdhocNoise(
      "column returns.refund_amount_cents does not exist",
      "update public.returns set refund_amount_cents = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingReturnsRefundAmountCentsColumnAdhocNoise(
      "column returns.refund_amount_cents does not exist",
      "delete from public.returns where refund_amount_cents is null",
    ),
    false,
  );
  // Empty / absent message or query never drops.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsRefundAmountCentsColumnAdhocNoise("", "select refund_amount_cents from returns"),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingReturnsRefundAmountCentsColumnAdhocNoise(
      "column returns.refund_amount_cents does not exist",
      "",
    ),
    false,
  );
});
