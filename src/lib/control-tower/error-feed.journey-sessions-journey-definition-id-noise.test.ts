/**
 * Unit tests for the `isForeignSupabasePostgresMissingJourneySessionsJourneyDefinitionIdColumnAdhocNoise`
 * capture-time noise filter (error-feed-drop-journey-sessions-journey-definition-id-missing-column spec).
 * Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.journey-sessions-journey-definition-id-noise.test.ts
 *
 * The captured incident (Control Tower signature `supabase-logs:41a56edd05f933c9`): a foreign /
 * BI / ETL / direct-REST client SELECTs the non-existent `journey_definition_id` column from
 * `journey_sessions` (the real FK to the journey definition is `journey_id`). The filter drops it
 * at capture while a real schema regression on a live `journey_sessions` column, the same column
 * name on another relation, or via a non-SELECT statement still pages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingJourneySessionsJourneyDefinitionIdColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingJourneySessionsJourneyDefinitionIdColumnAdhocNoise drops the bare + CTE foreign SELECT shapes", () => {
  // The bare `select ... from public.journey_sessions` shape.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsJourneyDefinitionIdColumnAdhocNoise(
      "column journey_sessions.journey_definition_id does not exist",
      "select id, journey_definition_id from public.journey_sessions order by created_at desc limit 10",
    ),
    true,
  );
  // The PostgREST-generated `WITH pgrst_source AS ( SELECT ... FROM "public"."journey_sessions" )`
  // CTE wrapper form with double-quoted identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsJourneyDefinitionIdColumnAdhocNoise(
      "column journey_sessions.journey_definition_id does not exist",
      'WITH pgrst_source AS ( SELECT "public"."journey_sessions"."id", "public"."journey_sessions"."journey_definition_id" FROM "public"."journey_sessions" LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsJourneyDefinitionIdColumnAdhocNoise(
      "column public.journey_sessions.journey_definition_id does not exist",
      'with pgrst_source as ( select "public"."journey_sessions"."journey_definition_id" from "public"."journey_sessions" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsJourneyDefinitionIdColumnAdhocNoise(
      "ERROR: column journey_sessions.journey_definition_id does not exist",
      "select * from journey_sessions where journey_definition_id = $1",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingJourneySessionsJourneyDefinitionIdColumnAdhocNoise KEEPS a different column, a non-SELECT write, another table, and empty markers (real regressions still page)", () => {
  // A DIFFERENT missing column on `journey_sessions` is a real schema regression and must still
  // page — the pin covers `journey_definition_id` only.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsJourneyDefinitionIdColumnAdhocNoise(
      "column journey_sessions.foo does not exist",
      "select id, foo from public.journey_sessions limit 1",
    ),
    false,
  );
  // The same message attached to a non-SELECT statement is a real code-write trying to persist a
  // bogus column — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsJourneyDefinitionIdColumnAdhocNoise(
      "column journey_sessions.journey_definition_id does not exist",
      "update public.journey_sessions set journey_definition_id = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsJourneyDefinitionIdColumnAdhocNoise(
      "column journey_sessions.journey_definition_id does not exist",
      "insert into public.journey_sessions (journey_definition_id) values ($1)",
    ),
    false,
  );
  // The same `journey_definition_id` column name on a DIFFERENT relation still pages.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsJourneyDefinitionIdColumnAdhocNoise(
      "column journey_step_runs.journey_definition_id does not exist",
      "select journey_definition_id from public.journey_step_runs limit 1",
    ),
    false,
  );
  // Empty / nullish input returns false — both markers required.
  assert.equal(isForeignSupabasePostgresMissingJourneySessionsJourneyDefinitionIdColumnAdhocNoise(null, null), false);
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsJourneyDefinitionIdColumnAdhocNoise(
      "column journey_sessions.journey_definition_id does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsJourneyDefinitionIdColumnAdhocNoise(
      "",
      "select journey_definition_id from public.journey_sessions limit 1",
    ),
    false,
  );
});
