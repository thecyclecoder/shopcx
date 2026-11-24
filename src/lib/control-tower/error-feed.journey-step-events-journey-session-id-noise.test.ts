/**
 * Unit tests for the `isForeignSupabasePostgresMissingJourneyStepEventsJourneySessionIdColumnAdhocNoise`
 * capture-time noise filter (error-feed-drop-journey-step-events-journey-session-id-adhoc spec).
 * Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.journey-step-events-journey-session-id-noise.test.ts
 *
 * The captured incident (Control Tower signature `supabase-logs:06892720c9da67d6`): a foreign /
 * stale direct-REST client SELECTs the non-existent `journey_session_id` column from
 * `journey_step_events` (our table's real column is `session_id`). The filter drops it at capture
 * while a real schema regression on a live `journey_step_events` column, the same column on
 * another relation, or via a non-SELECT statement still pages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingJourneyStepEventsJourneySessionIdColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingJourneyStepEventsJourneySessionIdColumnAdhocNoise drops the captured foreign journey_session_id read", () => {
  // The signature's captured shape: PostgREST wraps the foreign read as a
  // `WITH pgrst_source AS ( SELECT ... FROM "public"."journey_step_events" ... )` CTE and Postgres
  // rejects with `column journey_step_events.journey_session_id does not exist`.
  assert.equal(
    isForeignSupabasePostgresMissingJourneyStepEventsJourneySessionIdColumnAdhocNoise(
      "column journey_step_events.journey_session_id does not exist",
      'WITH pgrst_source AS ( SELECT "public"."journey_step_events"."id", "public"."journey_step_events"."journey_session_id" FROM "public"."journey_step_events" LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingJourneyStepEventsJourneySessionIdColumnAdhocNoise(
      "column public.journey_step_events.journey_session_id does not exist",
      'with pgrst_source as ( select "public"."journey_step_events"."journey_session_id" from "public"."journey_step_events" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingJourneyStepEventsJourneySessionIdColumnAdhocNoise(
      "ERROR: column journey_step_events.journey_session_id does not exist",
      "select id, journey_session_id from public.journey_step_events order by created_at desc limit 10",
    ),
    true,
  );
  // The unqualified-FROM (no `public.`) bare-SELECT variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingJourneyStepEventsJourneySessionIdColumnAdhocNoise(
      "column journey_step_events.journey_session_id does not exist",
      "select * from journey_step_events where journey_session_id = $1",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingJourneyStepEventsJourneySessionIdColumnAdhocNoise KEEPS live columns, other relations, and non-SELECT statements (real regressions still page)", () => {
  // A DIFFERENT missing column on `journey_step_events` is a real column rename / regression and
  // must still page — including the real `session_id` column. The pin covers `journey_session_id`
  // only.
  assert.equal(
    isForeignSupabasePostgresMissingJourneyStepEventsJourneySessionIdColumnAdhocNoise(
      "column journey_step_events.session_id does not exist",
      'WITH pgrst_source AS ( SELECT "public"."journey_step_events"."session_id" FROM "public"."journey_step_events" LIMIT 1 )',
    ),
    false,
  );
  // The same `journey_session_id` message on a DIFFERENT relation still pages.
  assert.equal(
    isForeignSupabasePostgresMissingJourneyStepEventsJourneySessionIdColumnAdhocNoise(
      "column journey_sessions.journey_session_id does not exist",
      "select journey_session_id from public.journey_sessions limit 1",
    ),
    false,
  );
  // The same message attached to a non-SELECT statement shape is a real code-write trying to
  // persist a bogus column — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingJourneyStepEventsJourneySessionIdColumnAdhocNoise(
      "column journey_step_events.journey_session_id does not exist",
      "update public.journey_step_events set journey_session_id = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingJourneyStepEventsJourneySessionIdColumnAdhocNoise(
      "column journey_step_events.journey_session_id does not exist",
      "insert into public.journey_step_events (journey_session_id) values ($1)",
    ),
    false,
  );
  // Empty / nullish input returns false — both markers required.
  assert.equal(isForeignSupabasePostgresMissingJourneyStepEventsJourneySessionIdColumnAdhocNoise(null, null), false);
  assert.equal(
    isForeignSupabasePostgresMissingJourneyStepEventsJourneySessionIdColumnAdhocNoise(
      "column journey_step_events.journey_session_id does not exist",
      "",
    ),
    false,
  );
});
