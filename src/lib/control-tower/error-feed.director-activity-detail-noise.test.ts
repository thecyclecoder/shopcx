/**
 * Unit tests for `isForeignSupabasePostgresMissingDirectorActivityDetailColumnAdhocNoise` — the
 * capture-time noise drop for a foreign/stale PostgREST client that selects the nonexistent
 * `director_activity.detail` column against `public.director_activity`. Built-in node:test — no
 * test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.director-activity-detail-noise.test.ts
 *
 * `director_activity` never carried a `detail` column; the offending read is not ShopCX code
 * (Control Tower signature `supabase-logs:ebc1e2907868a3c5`). Drop AT CAPTURE only when BOTH the
 * exact `column director_activity.detail does not exist` message AND the SELECT-lookup shape on
 * `director_activity` (bare or PostgREST CTE wrapper) are present. A different column on
 * director_activity, a different table, and a non-SELECT statement still page.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isForeignSupabasePostgresMissingDirectorActivityDetailColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingDirectorActivityDetailColumnAdhocNoise drops the PostgREST CTE wrapper + bare SELECT listing the non-existent detail column", () => {
  // The captured incident shape: a stale direct-REST client lists director_activity selecting
  // detail, PostgREST wraps it as a `WITH pgrst_source AS ( SELECT ... FROM
  // "public"."director_activity" ... )` CTE, and Postgres rejects with the column-missing.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityDetailColumnAdhocNoise(
      "column director_activity.detail does not exist",
      'WITH pgrst_source AS ( SELECT "public"."director_activity"."id", "public"."director_activity"."detail" FROM "public"."director_activity" ORDER BY "public"."director_activity"."detail" DESC LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityDetailColumnAdhocNoise(
      "column public.director_activity.detail does not exist",
      'with pgrst_source as ( select "public"."director_activity"."detail" from "public"."director_activity" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityDetailColumnAdhocNoise(
      "ERROR: column director_activity.detail does not exist",
      'WITH pgrst_source AS ( SELECT "detail" FROM "public"."director_activity" )',
    ),
    true,
  );
  // The bare SELECT form (not a PostgREST wrapper), qualified and unqualified FROM, drops.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityDetailColumnAdhocNoise(
      "column director_activity.detail does not exist",
      "select id, detail from public.director_activity order by detail desc limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityDetailColumnAdhocNoise(
      "column director_activity.detail does not exist",
      "select * from director_activity where detail is not null",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingDirectorActivityDetailColumnAdhocNoise KEEPS real errors (other column, other table, non-SELECT)", () => {
  // A DIFFERENT column on director_activity (a real column rename that broke a live query) still
  // pages — the pin is detail only.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityDetailColumnAdhocNoise(
      "column director_activity.reasoning does not exist",
      "select id, reasoning from public.director_activity",
    ),
    false,
  );
  // Same detail-missing message on a DIFFERENT relation is a real product-schema regression and
  // still pages — the pin names director_activity only.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityDetailColumnAdhocNoise(
      "column tickets.detail does not exist",
      "select id, detail from public.tickets order by detail desc",
    ),
    false,
  );
  // A non-SELECT shape (PostgREST CTE write / bare write) is a real code-bug and still pages.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityDetailColumnAdhocNoise(
      "column director_activity.detail does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."director_activity"("id","detail") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityDetailColumnAdhocNoise(
      "column director_activity.detail does not exist",
      "update public.director_activity set detail = $1 where id = $2",
    ),
    false,
  );
  // A FATAL / constraint-class error on the same shape is untouched (different message).
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityDetailColumnAdhocNoise(
      "FATAL: terminating connection due to administrator command",
      "select id, detail from public.director_activity",
    ),
    false,
  );
  // Empty / nullish message or query returns false — we need both markers.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityDetailColumnAdhocNoise("", "select * from director_activity"),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityDetailColumnAdhocNoise(
      "column director_activity.detail does not exist",
      "",
    ),
    false,
  );
});
