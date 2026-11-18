/**
 * Unit tests for `isForeignSupabasePostgresMissingCouponsValueCentsColumnAdhocNoise` — the
 * capture-time noise drop for a foreign/stale PostgREST client that selects the nonexistent
 * `coupons.value_cents` column against `public.coupons`. Built-in node:test — no test-runner
 * dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.coupons-value-cents-noise.test.ts
 *
 * ShopCX's `coupons` schema has never carried a cents-shaped `value_cents` column; the coupon
 * amount lives on the single `value` column. The offending read is not ShopCX code (Control Tower
 * signature `supabase-logs:6c1c30a9b575115d`). Drop AT CAPTURE only when BOTH the exact
 * `column coupons.value_cents does not exist` message AND the SELECT-lookup shape on `coupons`
 * (bare or PostgREST CTE wrapper) are present. A different column on coupons, a different table,
 * and a non-SELECT statement still page.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isForeignSupabasePostgresMissingCouponsValueCentsColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingCouponsValueCentsColumnAdhocNoise drops the PostgREST CTE wrapper + bare SELECT listing the non-existent value_cents column", () => {
  // The captured incident shape: a stale direct-REST client lists coupons selecting value_cents,
  // PostgREST wraps it as a `WITH pgrst_source AS ( SELECT ... FROM "public"."coupons" ... )` CTE,
  // and Postgres rejects with the column-missing.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsValueCentsColumnAdhocNoise(
      "column coupons.value_cents does not exist",
      'WITH pgrst_source AS ( SELECT "public"."coupons"."id", "public"."coupons"."code", "public"."coupons"."value_cents" FROM "public"."coupons" ORDER BY "public"."coupons"."value_cents" DESC LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsValueCentsColumnAdhocNoise(
      "column public.coupons.value_cents does not exist",
      'with pgrst_source as ( select "public"."coupons"."value_cents" from "public"."coupons" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsValueCentsColumnAdhocNoise(
      "ERROR: column coupons.value_cents does not exist",
      'WITH pgrst_source AS ( SELECT "value_cents" FROM "public"."coupons" )',
    ),
    true,
  );
  // The bare SELECT form (not a PostgREST wrapper), qualified and unqualified FROM, drops.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsValueCentsColumnAdhocNoise(
      "column coupons.value_cents does not exist",
      "select id, value_cents from public.coupons order by value_cents desc limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCouponsValueCentsColumnAdhocNoise(
      "column coupons.value_cents does not exist",
      "select * from coupons where value_cents is not null",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingCouponsValueCentsColumnAdhocNoise KEEPS real errors (other column, other table, non-SELECT)", () => {
  // A DIFFERENT column on coupons (e.g. the sibling `status` foreign-read is a separate signature,
  // or a real column rename that broke a live query) still pages — the pin is value_cents only.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsValueCentsColumnAdhocNoise(
      "column coupons.status does not exist",
      "select id, status from public.coupons",
    ),
    false,
  );
  // Same value_cents-missing message on a DIFFERENT relation is a real product-schema regression
  // and still pages — the pin names coupons only.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsValueCentsColumnAdhocNoise(
      "column orders.value_cents does not exist",
      "select id, value_cents from public.orders order by value_cents desc",
    ),
    false,
  );
  // A non-SELECT shape (PostgREST CTE write / bare write) is a real code-bug and still pages.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsValueCentsColumnAdhocNoise(
      "column coupons.value_cents does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."coupons"("id","value_cents") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCouponsValueCentsColumnAdhocNoise(
      "column coupons.value_cents does not exist",
      "update public.coupons set value_cents = $1 where id = $2",
    ),
    false,
  );
  // A FATAL / constraint-class error on the same shape is untouched (different message).
  assert.equal(
    isForeignSupabasePostgresMissingCouponsValueCentsColumnAdhocNoise(
      "FATAL: terminating connection due to administrator command",
      "select id, value_cents from public.coupons",
    ),
    false,
  );
  // Empty / nullish message or query returns false — we need both markers.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsValueCentsColumnAdhocNoise("", "select * from coupons"),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCouponsValueCentsColumnAdhocNoise("column coupons.value_cents does not exist", ""),
    false,
  );
});
