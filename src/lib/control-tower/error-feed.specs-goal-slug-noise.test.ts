/**
 * Unit tests for `isForeignSupabasePostgresMissingSpecsGoalSlugAdhocNoise` — the
 * capture-time noise drop for a foreign/stale PostgREST client that selects the nonexistent
 * `specs.goal_slug` column against `public.specs`. Built-in node:test — no test-runner
 * dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.specs-goal-slug-noise.test.ts
 *
 * ShopCX models a spec's goal linkage on `specs.milestone_id` / `goal_branch_sha` and never
 * carried a `goal_slug` column on `specs`; the offending read is not ShopCX code (Control
 * Tower signature `supabase-logs:089b48e5daedc132`). Drop AT CAPTURE only when BOTH the exact
 * `column specs.goal_slug does not exist` message AND the SELECT-lookup shape on `specs`
 * (bare or PostgREST CTE wrapper) are present. A different column on specs, a different table,
 * and a non-SELECT statement still page.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isForeignSupabasePostgresMissingSpecsGoalSlugAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingSpecsGoalSlugAdhocNoise drops the PostgREST CTE wrapper + bare SELECT listing the non-existent goal_slug column", () => {
  // The captured incident shape: a stale direct-REST client lists specs selecting goal_slug,
  // PostgREST wraps it as a `WITH pgrst_source AS ( SELECT ... FROM "public"."specs" ... )` CTE,
  // and Postgres rejects with the column-missing.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsGoalSlugAdhocNoise(
      "column specs.goal_slug does not exist",
      'WITH pgrst_source AS ( SELECT "public"."specs"."slug", "public"."specs"."status", "public"."specs"."goal_slug" FROM "public"."specs" ORDER BY "public"."specs"."goal_slug" DESC LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsGoalSlugAdhocNoise(
      "column public.specs.goal_slug does not exist",
      'with pgrst_source as ( select "public"."specs"."goal_slug" from "public"."specs" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsGoalSlugAdhocNoise(
      "ERROR: column specs.goal_slug does not exist",
      'WITH pgrst_source AS ( SELECT "goal_slug" FROM "public"."specs" )',
    ),
    true,
  );
  // The bare SELECT form (not a PostgREST wrapper), qualified and unqualified FROM, drops.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsGoalSlugAdhocNoise(
      "column specs.goal_slug does not exist",
      "select slug, goal_slug from public.specs order by goal_slug desc limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsGoalSlugAdhocNoise(
      "column specs.goal_slug does not exist",
      "select * from specs where goal_slug is not null",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsGoalSlugAdhocNoise KEEPS real errors (other column, other table, non-SELECT)", () => {
  // A DIFFERENT column on specs (a real column rename that broke a live query) still pages —
  // the pin is goal_slug only.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsGoalSlugAdhocNoise(
      "column specs.status does not exist",
      "select slug, status from public.specs",
    ),
    false,
  );
  // Same goal_slug-missing message on a DIFFERENT relation is a real product-schema
  // regression and still pages — the pin names specs only.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsGoalSlugAdhocNoise(
      "column goals.goal_slug does not exist",
      "select id, goal_slug from public.goals order by goal_slug desc",
    ),
    false,
  );
  // A non-SELECT shape (PostgREST CTE write / bare write) is a real code-bug and still pages.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsGoalSlugAdhocNoise(
      "column specs.goal_slug does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."specs"("slug","goal_slug") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsGoalSlugAdhocNoise(
      "column specs.goal_slug does not exist",
      "update public.specs set goal_slug = $1 where id = $2",
    ),
    false,
  );
  // A FATAL / constraint-class error on the same shape is untouched (different message).
  assert.equal(
    isForeignSupabasePostgresMissingSpecsGoalSlugAdhocNoise(
      "FATAL: terminating connection due to administrator command",
      "select slug, goal_slug from public.specs",
    ),
    false,
  );
  // Empty / nullish message or query returns false — we need both markers.
  assert.equal(isForeignSupabasePostgresMissingSpecsGoalSlugAdhocNoise("", "select * from specs"), false);
  assert.equal(
    isForeignSupabasePostgresMissingSpecsGoalSlugAdhocNoise("column specs.goal_slug does not exist", ""),
    false,
  );
});
