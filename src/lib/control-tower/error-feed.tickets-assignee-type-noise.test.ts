/**
 * Unit tests for the `isForeignSupabasePostgresMissingTicketsAssigneeTypeColumnAdhocNoise`
 * capture-time noise filter (error-feed-drop-tickets-assignee-type-adhoc-column-noise spec).
 * Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.tickets-assignee-type-noise.test.ts
 *
 * The captured incident (Control Tower signature `supabase-logs:4c8819ba3f4b0f49`): a foreign /
 * stale direct-REST client SELECTs the non-existent `assignee_type` column from `tickets` (our
 * `tickets` table never owned an `assignee_type` column). The filter drops it at capture while a
 * real schema regression on a live `tickets` column, the same column on another relation, or via
 * a non-SELECT statement still pages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingTicketsAssigneeTypeColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingTicketsAssigneeTypeColumnAdhocNoise drops the captured foreign assignee_type read", () => {
  // The signature's captured shape: PostgREST wraps the foreign read as a
  // `WITH pgrst_source AS ( SELECT ... FROM "public"."tickets" ... )` CTE and Postgres rejects
  // with `column tickets.assignee_type does not exist`.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssigneeTypeColumnAdhocNoise(
      "column tickets.assignee_type does not exist",
      'WITH pgrst_source AS ( SELECT "public"."tickets"."id", "public"."tickets"."assignee_type" FROM "public"."tickets" LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssigneeTypeColumnAdhocNoise(
      "column public.tickets.assignee_type does not exist",
      'with pgrst_source as ( select "public"."tickets"."assignee_type" from "public"."tickets" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssigneeTypeColumnAdhocNoise(
      "ERROR: column tickets.assignee_type does not exist",
      "select id, assignee_type from public.tickets order by created_at desc limit 10",
    ),
    true,
  );
  // The unqualified-FROM (no `public.`) bare-SELECT variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssigneeTypeColumnAdhocNoise(
      "column tickets.assignee_type does not exist",
      "select * from tickets where assignee_type = $1",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingTicketsAssigneeTypeColumnAdhocNoise KEEPS live columns, other relations, and non-SELECT statements (real regressions still page)", () => {
  // A DIFFERENT missing column on `tickets` is a real column rename / regression and must still
  // page — the pin covers `assignee_type` only.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssigneeTypeColumnAdhocNoise(
      "column tickets.status does not exist",
      'WITH pgrst_source AS ( SELECT "public"."tickets"."status" FROM "public"."tickets" LIMIT 1 )',
    ),
    false,
  );
  // The same `assignee_type` message on a DIFFERENT relation still pages.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssigneeTypeColumnAdhocNoise(
      "column assignments.assignee_type does not exist",
      "select assignee_type from public.assignments limit 1",
    ),
    false,
  );
  // The same `assignee_type` message attached to a non-SELECT statement shape is a real
  // code-write trying to persist a bogus column — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssigneeTypeColumnAdhocNoise(
      "column tickets.assignee_type does not exist",
      "update public.tickets set assignee_type = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssigneeTypeColumnAdhocNoise(
      "column tickets.assignee_type does not exist",
      "insert into public.tickets (assignee_type) values ($1)",
    ),
    false,
  );
  // Empty / nullish input returns false — both markers required.
  assert.equal(isForeignSupabasePostgresMissingTicketsAssigneeTypeColumnAdhocNoise(null, null), false);
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssigneeTypeColumnAdhocNoise(
      "column tickets.assignee_type does not exist",
      "",
    ),
    false,
  );
});
