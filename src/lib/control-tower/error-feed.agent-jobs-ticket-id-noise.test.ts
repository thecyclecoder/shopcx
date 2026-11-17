/**
 * Unit tests for the `isForeignSupabasePostgresMissingAgentJobsTicketIdColumnAdhocNoise`
 * capture-time noise filter (error-feed-drop-agent-jobs-ticket-id-column-adhoc-noise spec).
 * Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.agent-jobs-ticket-id-noise.test.ts
 *
 * The captured incident (Control Tower signature `supabase-logs:0cb4814c57302d32`): a foreign /
 * stale direct-REST client SELECTs the non-existent `ticket_id` column from `agent_jobs`
 * (jobs reference their ticket through the payload, not a top-level column). The filter drops it
 * at capture while a real schema regression on a different column or via a non-SELECT statement
 * still pages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingAgentJobsTicketIdColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingAgentJobsTicketIdColumnAdhocNoise drops the PostgREST CTE wrapper lookup projecting the non-existent ticket_id column", () => {
  // The signature's captured shape: PostgREST wraps the foreign read as a
  // `WITH pgrst_source AS ( SELECT ... FROM "public"."agent_jobs" ... )` CTE and Postgres rejects
  // with `column agent_jobs.ticket_id does not exist`.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTicketIdColumnAdhocNoise(
      "column agent_jobs.ticket_id does not exist",
      'WITH pgrst_source AS ( SELECT "public"."agent_jobs"."id", "public"."agent_jobs"."ticket_id" FROM "public"."agent_jobs" LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTicketIdColumnAdhocNoise(
      "column public.agent_jobs.ticket_id does not exist",
      'with pgrst_source as ( select "public"."agent_jobs"."ticket_id" from "public"."agent_jobs" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTicketIdColumnAdhocNoise(
      "ERROR: column agent_jobs.ticket_id does not exist",
      'WITH pgrst_source AS ( SELECT "ticket_id" FROM "public"."agent_jobs" )',
    ),
    true,
  );
  // The bare SELECT form (not a PostgREST wrapper) also drops — same foreign surface.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTicketIdColumnAdhocNoise(
      "column agent_jobs.ticket_id does not exist",
      "select id, ticket_id from public.agent_jobs order by created_at desc limit 10",
    ),
    true,
  );
  // The unqualified-FROM (no `public.`) variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTicketIdColumnAdhocNoise(
      "column agent_jobs.ticket_id does not exist",
      "select * from agent_jobs where ticket_id = $1",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTicketIdColumnAdhocNoise KEEPS a different column error and a non-SELECT statement (real regressions still page)", () => {
  // A DIFFERENT missing column on `agent_jobs` (e.g. `finished_at`) is a real column rename /
  // regression and must still page — the pin covers `ticket_id` only.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTicketIdColumnAdhocNoise(
      "column agent_jobs.finished_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."agent_jobs"."finished_at" FROM "public"."agent_jobs" LIMIT 1 )',
    ),
    false,
  );
  // The same `ticket_id` message attached to a non-SELECT statement shape is a real code-write
  // trying to persist a bogus column — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTicketIdColumnAdhocNoise(
      "column agent_jobs.ticket_id does not exist",
      "update public.agent_jobs set ticket_id = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTicketIdColumnAdhocNoise(
      "column agent_jobs.ticket_id does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."agent_jobs"("id","ticket_id") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  // The `ticket_id` message on a DIFFERENT relation (a real product-schema regression) still pages.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTicketIdColumnAdhocNoise(
      "column jobs.ticket_id does not exist",
      "select ticket_id from public.jobs limit 1",
    ),
    false,
  );
  // Empty / nullish input returns false — both markers required.
  assert.equal(isForeignSupabasePostgresMissingAgentJobsTicketIdColumnAdhocNoise(null, null), false);
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTicketIdColumnAdhocNoise(
      "column agent_jobs.ticket_id does not exist",
      "",
    ),
    false,
  );
});
