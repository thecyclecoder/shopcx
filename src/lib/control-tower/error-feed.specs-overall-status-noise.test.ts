/**
 * Unit tests for `isForeignSupabasePostgresMissingSpecsOverallStatusColumnAdhocNoise` — the
 * capture-time noise drop for a foreign/stale PostgREST client that selects the nonexistent
 * `specs.overall_status` (+ sibling `phase_states`) column against `public.specs`. Built-in
 * node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.specs-overall-status-noise.test.ts
 *
 * ShopCX derives spec status from the `spec_phases` rollup and never carried an
 * `overall_status` column on `specs`; the offending read is not ShopCX code (Control Tower
 * signature `supabase-logs:bee6f06d07aad446`). Drop AT CAPTURE only when BOTH the exact
 * `column specs.overall_status does not exist` message AND the SELECT-lookup shape on `specs`
 * (bare or PostgREST CTE wrapper) are present. A different column on specs, a different table,
 * and a non-SELECT statement still page.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isForeignSupabasePostgresMissingSpecsOverallStatusColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingSpecsOverallStatusColumnAdhocNoise drops the PostgREST CTE wrapper + bare SELECT listing the non-existent overall_status column", () => {
  // The captured incident shape: a stale direct-REST client lists specs selecting overall_status,
  // PostgREST wraps it as a `WITH pgrst_source AS ( SELECT ... FROM "public"."specs" ... )` CTE,
  // and Postgres rejects with the column-missing.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOverallStatusColumnAdhocNoise(
      "column specs.overall_status does not exist",
      'WITH pgrst_source AS ( SELECT "public"."specs"."id", "public"."specs"."overall_status", "public"."specs"."phase_states" FROM "public"."specs" ORDER BY "public"."specs"."overall_status" DESC LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOverallStatusColumnAdhocNoise(
      "column public.specs.overall_status does not exist",
      'with pgrst_source as ( select "public"."specs"."overall_status" from "public"."specs" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOverallStatusColumnAdhocNoise(
      "ERROR: column specs.overall_status does not exist",
      'WITH pgrst_source AS ( SELECT "overall_status" FROM "public"."specs" )',
    ),
    true,
  );
  // The bare SELECT form (not a PostgREST wrapper), qualified and unqualified FROM, drops.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOverallStatusColumnAdhocNoise(
      "column specs.overall_status does not exist",
      "select id, overall_status from public.specs order by overall_status desc limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOverallStatusColumnAdhocNoise(
      "column specs.overall_status does not exist",
      "select * from specs where overall_status is not null",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsOverallStatusColumnAdhocNoise KEEPS real errors (other column, other table, non-SELECT)", () => {
  // A DIFFERENT column on specs (a real column rename that broke a live query) still pages —
  // the pin is overall_status only.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOverallStatusColumnAdhocNoise(
      "column specs.status does not exist",
      "select id, status from public.specs",
    ),
    false,
  );
  // Same overall_status-missing message on a DIFFERENT relation is a real product-schema
  // regression and still pages — the pin names specs only.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOverallStatusColumnAdhocNoise(
      "column goals.overall_status does not exist",
      "select id, overall_status from public.goals order by overall_status desc",
    ),
    false,
  );
  // A non-SELECT shape (PostgREST CTE write / bare write) is a real code-bug and still pages.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOverallStatusColumnAdhocNoise(
      "column specs.overall_status does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."specs"("id","overall_status") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOverallStatusColumnAdhocNoise(
      "column specs.overall_status does not exist",
      "update public.specs set overall_status = $1 where id = $2",
    ),
    false,
  );
  // A FATAL / constraint-class error on the same shape is untouched (different message).
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOverallStatusColumnAdhocNoise(
      "FATAL: terminating connection due to administrator command",
      "select id, overall_status from public.specs",
    ),
    false,
  );
  // Empty / nullish message or query returns false — we need both markers.
  assert.equal(isForeignSupabasePostgresMissingSpecsOverallStatusColumnAdhocNoise("", "select * from specs"), false);
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOverallStatusColumnAdhocNoise("column specs.overall_status does not exist", ""),
    false,
  );
});
