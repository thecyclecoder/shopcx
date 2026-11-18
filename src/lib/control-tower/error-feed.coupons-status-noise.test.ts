/**
 * Unit tests for `isForeignSupabasePostgresMissingCouponsStatusColumnAdhocNoise` — the
 * capture-time noise drop for a foreign/stale PostgREST client that selects the nonexistent
 * `coupons.status` column against `public.coupons`. Built-in node:test — no test-runner
 * dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.coupons-status-noise.test.ts
 *
 * ShopCX's `coupons` schema has never carried a scalar `status` column; the offending read is
 * not ShopCX code (Control Tower signature `supabase-logs:b02068974ae0efb2`). Drop AT CAPTURE
 * only when BOTH the exact `column coupons.status does not exist` message AND the SELECT-lookup
 * shape on `coupons` (bare or PostgREST CTE wrapper) are present. A different column on coupons,
 * a different table, and a non-SELECT statement still page.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isForeignSupabasePostgresMissingCouponsStatusColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingCouponsStatusColumnAdhocNoise drops the PostgREST CTE wrapper + bare SELECT listing the non-existent status column", () => {
  // The captured incident shape: a stale direct-REST client lists coupons selecting status,
  // PostgREST wraps it as a `WITH pgrst_source AS ( SELECT ... FROM "public"."coupons" ... )` CTE,
  // and Postgres rejects with the column-missing.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsStatusColumnAdhocNoise(
      "column coupons.status does not exist",
      'WITH pgrst_source AS ( SELECT "public"."coupons"."id", "public"."coupons"."code", "public"."coupons"."status" FROM "public"."coupons" ORDER BY "public"."coupons"."status" DESC LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsStatusColumnAdhocNoise(
      "column public.coupons.status does not exist",
      'with pgrst_source as ( select "public"."coupons"."status" from "public"."coupons" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsStatusColumnAdhocNoise(
      "ERROR: column coupons.status does not exist",
      'WITH pgrst_source AS ( SELECT "status" FROM "public"."coupons" )',
    ),
    true,
  );
  // The bare SELECT form (not a PostgREST wrapper), qualified and unqualified FROM, drops.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsStatusColumnAdhocNoise(
      "column coupons.status does not exist",
      "select id, status from public.coupons order by status desc limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCouponsStatusColumnAdhocNoise(
      "column coupons.status does not exist",
      "select * from coupons where status is not null",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingCouponsStatusColumnAdhocNoise KEEPS real errors (other column, other table, non-SELECT)", () => {
  // A DIFFERENT column on coupons (e.g. the related `source` foreign-read is a separate
  // signature, or a real column rename that broke a live query) still pages — the pin is
  // status only.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsStatusColumnAdhocNoise(
      "column coupons.source does not exist",
      "select id, source from public.coupons",
    ),
    false,
  );
  // Same status-missing message on a DIFFERENT relation is a real product-schema regression and
  // still pages — the pin names coupons only.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsStatusColumnAdhocNoise(
      "column specs.status does not exist",
      "select id, status from public.specs order by status desc",
    ),
    false,
  );
  // A non-SELECT shape (PostgREST CTE write / bare write) is a real code-bug and still pages.
  assert.equal(
    isForeignSupabasePostgresMissingCouponsStatusColumnAdhocNoise(
      "column coupons.status does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."coupons"("id","status") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCouponsStatusColumnAdhocNoise(
      "column coupons.status does not exist",
      "update public.coupons set status = $1 where id = $2",
    ),
    false,
  );
  // A FATAL / constraint-class error on the same shape is untouched (different message).
  assert.equal(
    isForeignSupabasePostgresMissingCouponsStatusColumnAdhocNoise(
      "FATAL: terminating connection due to administrator command",
      "select id, status from public.coupons",
    ),
    false,
  );
  // Empty / nullish message or query returns false — we need both markers.
  assert.equal(isForeignSupabasePostgresMissingCouponsStatusColumnAdhocNoise("", "select * from coupons"), false);
  assert.equal(
    isForeignSupabasePostgresMissingCouponsStatusColumnAdhocNoise("column coupons.status does not exist", ""),
    false,
  );
});
