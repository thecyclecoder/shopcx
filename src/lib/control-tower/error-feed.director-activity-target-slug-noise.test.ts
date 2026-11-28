/**
 * Unit tests for `isForeignSupabasePostgresMissingDirectorActivityTargetSlugColumnAdhocNoise` — the
 * capture-time noise drop for a foreign/stale PostgREST client that selects the nonexistent
 * `director_activity.target_slug` column against `public.director_activity`. Built-in node:test — no
 * test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.director-activity-target-slug-noise.test.ts
 *
 * `director_activity` never carried a `target_slug` column; the offending read is not ShopCX code
 * (Control Tower signature `supabase-logs:d7ed3e7a4e0ef65f`). Drop AT CAPTURE only when BOTH the
 * exact `column director_activity.target_slug does not exist` message AND the SELECT-lookup shape on
 * `director_activity` (bare or PostgREST CTE wrapper) are present. A different column on
 * director_activity, a different table, and a non-SELECT statement still page.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isForeignSupabasePostgresMissingDirectorActivityTargetSlugColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingDirectorActivityTargetSlugColumnAdhocNoise drops the PostgREST CTE wrapper + bare SELECT listing the non-existent target_slug column", () => {
  // The captured incident shape: a stale direct-REST client lists director_activity selecting
  // target_slug, PostgREST wraps it as a `WITH pgrst_source AS ( SELECT ... FROM
  // "public"."director_activity" ... )` CTE, and Postgres rejects with the column-missing.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityTargetSlugColumnAdhocNoise(
      "column director_activity.target_slug does not exist",
      'WITH pgrst_source AS ( SELECT "public"."director_activity"."id", "public"."director_activity"."target_slug" FROM "public"."director_activity" ORDER BY "public"."director_activity"."target_slug" DESC LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityTargetSlugColumnAdhocNoise(
      "column public.director_activity.target_slug does not exist",
      'with pgrst_source as ( select "public"."director_activity"."target_slug" from "public"."director_activity" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityTargetSlugColumnAdhocNoise(
      "ERROR: column director_activity.target_slug does not exist",
      'WITH pgrst_source AS ( SELECT "target_slug" FROM "public"."director_activity" )',
    ),
    true,
  );
  // The bare SELECT form (not a PostgREST wrapper), qualified and unqualified FROM, drops.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityTargetSlugColumnAdhocNoise(
      "column director_activity.target_slug does not exist",
      "select id, target_slug from public.director_activity order by target_slug desc limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityTargetSlugColumnAdhocNoise(
      "column director_activity.target_slug does not exist",
      "select * from director_activity where target_slug is not null",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingDirectorActivityTargetSlugColumnAdhocNoise KEEPS real errors (other column, other table, non-SELECT)", () => {
  // A DIFFERENT column on director_activity (a real column rename that broke a live query) still
  // pages — the pin is target_slug only.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityTargetSlugColumnAdhocNoise(
      "column director_activity.reasoning does not exist",
      "select id, reasoning from public.director_activity",
    ),
    false,
  );
  // Same target_slug-missing message on a DIFFERENT relation is a real product-schema regression
  // and still pages — the pin names director_activity only.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityTargetSlugColumnAdhocNoise(
      "column specs.target_slug does not exist",
      "select id, target_slug from public.specs order by target_slug desc",
    ),
    false,
  );
  // A non-SELECT shape (PostgREST CTE write / bare write) is a real code-bug and still pages.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityTargetSlugColumnAdhocNoise(
      "column director_activity.target_slug does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."director_activity"("id","target_slug") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityTargetSlugColumnAdhocNoise(
      "column director_activity.target_slug does not exist",
      "update public.director_activity set target_slug = $1 where id = $2",
    ),
    false,
  );
  // A FATAL / constraint-class error on the same shape is untouched (different message).
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityTargetSlugColumnAdhocNoise(
      "FATAL: terminating connection due to administrator command",
      "select id, target_slug from public.director_activity",
    ),
    false,
  );
  // Empty / nullish message or query returns false — we need both markers.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityTargetSlugColumnAdhocNoise(
      "",
      "select * from director_activity",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityTargetSlugColumnAdhocNoise(
      "column director_activity.target_slug does not exist",
      "",
    ),
    false,
  );
});
