/**
 * Unit tests for the `isForeignSupabasePostgresMissingJourneySessionsUpdatedAtColumnAdhocNoise`
 * capture-time noise filter (error-feed-drop-journey-sessions-updated-at-missing-column spec).
 * Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.journey-sessions-updated-at-noise.test.ts
 *
 * The captured incident (Control Tower signature `supabase-logs:87d1a6250e77a6a4`): a foreign /
 * stale direct-REST / BI / ETL client SELECTs the non-existent `updated_at` column from
 * `journey_sessions` (our table has never carried an `updated_at` column). The filter drops it at
 * capture while a real schema regression on a live `journey_sessions` column, the same column on
 * another relation, or via a non-SELECT statement still pages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingJourneySessionsUpdatedAtColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingJourneySessionsUpdatedAtColumnAdhocNoise drops the bare + CTE foreign SELECT shapes", () => {
  // The bare `select ... from public.journey_sessions` shape.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsUpdatedAtColumnAdhocNoise(
      "column journey_sessions.updated_at does not exist",
      "select id, updated_at from public.journey_sessions order by updated_at desc limit 10",
    ),
    true,
  );
  // The PostgREST-generated `WITH pgrst_source AS ( SELECT ... FROM "public"."journey_sessions" )`
  // CTE wrapper form with double-quoted identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsUpdatedAtColumnAdhocNoise(
      "column journey_sessions.updated_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."journey_sessions"."id", "public"."journey_sessions"."updated_at" FROM "public"."journey_sessions" LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsUpdatedAtColumnAdhocNoise(
      "column public.journey_sessions.updated_at does not exist",
      'with pgrst_source as ( select "public"."journey_sessions"."updated_at" from "public"."journey_sessions" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsUpdatedAtColumnAdhocNoise(
      "ERROR: column journey_sessions.updated_at does not exist",
      "select * from journey_sessions where updated_at > $1",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingJourneySessionsUpdatedAtColumnAdhocNoise KEEPS a different column, a non-SELECT write, another table, and empty markers (real regressions still page)", () => {
  // A DIFFERENT missing column on `journey_sessions` is a real schema regression and must still
  // page — the pin covers `updated_at` only.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsUpdatedAtColumnAdhocNoise(
      "column journey_sessions.foo does not exist",
      "select id, foo from public.journey_sessions limit 1",
    ),
    false,
  );
  // The same message attached to a non-SELECT statement is a real code-write trying to persist a
  // bogus column — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsUpdatedAtColumnAdhocNoise(
      "column journey_sessions.updated_at does not exist",
      "update public.journey_sessions set updated_at = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsUpdatedAtColumnAdhocNoise(
      "column journey_sessions.updated_at does not exist",
      "insert into public.journey_sessions (updated_at) values ($1)",
    ),
    false,
  );
  // The same `updated_at` column name on a DIFFERENT relation still pages.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsUpdatedAtColumnAdhocNoise(
      "column journey_definitions.updated_at does not exist",
      "select updated_at from public.journey_definitions limit 1",
    ),
    false,
  );
  // Empty / nullish input returns false — both markers required.
  assert.equal(isForeignSupabasePostgresMissingJourneySessionsUpdatedAtColumnAdhocNoise(null, null), false);
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsUpdatedAtColumnAdhocNoise(
      "column journey_sessions.updated_at does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsUpdatedAtColumnAdhocNoise(
      "",
      "select updated_at from public.journey_sessions limit 1",
    ),
    false,
  );
});
