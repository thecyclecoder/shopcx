/**
 * Unit tests for `isForeignSupabasePostgresMissingCouponsOneTimeColumnAdhocNoise` — the
 * capture-time noise drop for a foreign/stale PostgREST client that selects the nonexistent
 * Appstle-style `coupons.one_time` column against `public.coupons`. Built-in node:test — no
 * test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.coupons-one-time-noise.test.ts
 *
 * ShopCX's `coupons` schema has never carried a boolean `one_time` column; the offending read is
 * not ShopCX code (Control Tower signature `supabase-logs:391074d76ddc779c`). Drop AT CAPTURE
 * only when BOTH the exact `column coupons.one_time does not exist` message AND the SELECT-lookup
 * shape on `coupons` (bare or PostgREST CTE wrapper) are present. A different column on coupons,
 * a different table, and a non-SELECT statement still page.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isForeignSupabasePostgresMissingCouponsOneTimeColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingCouponsOneTimeColumnAdhocNoise drops the PostgREST CTE wrapper + bare SELECT listing the non-existent one_time column", () => {
  // The captured incident shape: a stale direct-REST client lists coupons selecting one_time,
  // PostgREST wraps it as a `WITH pgrst_source AS ( SELECT ... FROM "public"."coupons" ... )` CTE,
  // and Postgres rejects with the column-missing.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsOneTimeColumnAdhocNoise(
      "column coupons.one_time does not exist",
      'WITH pgrst_source AS ( SELECT "public"."coupons"."id", "public"."coupons"."code", "public"."coupons"."one_time" FROM "public"."coupons" ORDER BY "public"."coupons"."one_time" DESC LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsOneTimeColumnAdhocNoise(
      "column public.coupons.one_time does not exist",
      'with pgrst_source as ( select "public"."coupons"."one_time" from "public"."coupons" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsOneTimeColumnAdhocNoise(
      "ERROR: column coupons.one_time does not exist",
      'WITH pgrst_source AS ( SELECT "one_time" FROM "public"."coupons" )',
    ),
    true,
  );
  // The bare SELECT form (not a PostgREST wrapper), qualified and unqualified FROM, drops.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsOneTimeColumnAdhocNoise(
      "column coupons.one_time does not exist",
      "select id, one_time from public.coupons order by one_time desc limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCouponsOneTimeColumnAdhocNoise(
      "column coupons.one_time does not exist",
      "select * from coupons where one_time is not null",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingCouponsOneTimeColumnAdhocNoise KEEPS real errors (other column, other table, non-SELECT)", () => {
  // A DIFFERENT column on coupons (e.g. the related `value_cents` / `status` foreign-reads are
  // separate signatures, or a real column rename that broke a live query) still pages — the pin is
  // one_time only.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsOneTimeColumnAdhocNoise(
      "column coupons.value_cents does not exist",
      "select id, value_cents from public.coupons",
    ),
    false,
  );
  // Same one_time-missing message on a DIFFERENT relation is a real product-schema regression and
  // still pages — the pin names coupons only.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsOneTimeColumnAdhocNoise(
      "column one_time_charges.one_time does not exist",
      "select id, one_time from public.one_time_charges order by one_time desc",
    ),
    false,
  );
  // A non-SELECT shape (PostgREST CTE write / bare write) is a real code-bug and still pages.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsOneTimeColumnAdhocNoise(
      "column coupons.one_time does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."coupons"("id","one_time") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCouponsOneTimeColumnAdhocNoise(
      "column coupons.one_time does not exist",
      "update public.coupons set one_time = $1 where id = $2",
    ),
    false,
  );
  // A FATAL / constraint-class error on the same shape is untouched (different message).
  assert.equal(
    isForeignSupabasePostgresMissingCouponsOneTimeColumnAdhocNoise(
      "FATAL: terminating connection due to administrator command",
      "select id, one_time from public.coupons",
    ),
    false,
  );
  // Empty / nullish message or query returns false — we need both markers.
  assert.equal(isForeignSupabasePostgresMissingCouponsOneTimeColumnAdhocNoise("", "select * from coupons"), false);
  assert.equal(
    isForeignSupabasePostgresMissingCouponsOneTimeColumnAdhocNoise("column coupons.one_time does not exist", ""),
    false,
  );
});
