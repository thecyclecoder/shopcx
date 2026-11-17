/**
 * Unit test for the `crisis_customer_actions.contract_id` foreign-app noise-drop predicate
 * (error-feed-drop-crisis-customer-actions-contract-id-direct-rest spec, Control Tower
 * signature supabase-logs:988b381bb718bd21). Built-in node:test — no test-runner
 * dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.crisis-customer-actions-contract-id-noise.test.ts
 *
 * Our `crisis_customer_actions` table exists but has NEVER carried a `contract_id` column
 * (it is a sibling off-schema name alongside the already-pinned `crisis_event_id` /
 * `status` / `tier`) — no ShopCX code path filters this table by any `contract_id`. The
 * message surfaces only when a foreign / stale / manual PostgREST client issues an ad hoc
 * SELECT lookup. Drop AT CAPTURE only when BOTH the exact column-missing message on
 * `crisis_customer_actions.contract_id` AND a SELECT-lookup shape on
 * `crisis_customer_actions` (bare OR PostgREST CTE wrapper) are present. A column-missing
 * on a different `crisis_customer_actions` column, on `contract_id` from any other table,
 * or via a non-SELECT statement still pages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingCrisisCustomerActionsColumnDirectRestNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingCrisisCustomerActionsColumnDirectRestNoise drops the captured contract_id PostgREST-wrapped + bare-SELECT samples", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-missing
  // message on `crisis_customer_actions.contract_id` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingCrisisCustomerActionsColumnDirectRestNoise(
      "column crisis_customer_actions.contract_id does not exist",
      'WITH pgrst_source AS ( SELECT "public"."crisis_customer_actions"."id", "public"."crisis_customer_actions"."contract_id" FROM "public"."crisis_customer_actions" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCrisisCustomerActionsColumnDirectRestNoise(
      "column public.crisis_customer_actions.contract_id does not exist",
      'WITH pgrst_source AS (SELECT "public"."crisis_customer_actions"."contract_id" FROM "public"."crisis_customer_actions")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingCrisisCustomerActionsColumnDirectRestNoise(
      "column crisis_customer_actions.contract_id does not exist",
      "select id, contract_id from public.crisis_customer_actions where contract_id = 'x'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCrisisCustomerActionsColumnDirectRestNoise(
      "column crisis_customer_actions.contract_id does not exist",
      "select contract_id from crisis_customer_actions limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingCrisisCustomerActionsColumnDirectRestNoise(
      "ERROR: column crisis_customer_actions.contract_id does not exist",
      'WITH pgrst_source AS (SELECT "public"."crisis_customer_actions"."contract_id" FROM "public"."crisis_customer_actions")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingCrisisCustomerActionsColumnDirectRestNoise KEEPS a DIFFERENT column on crisis_customer_actions (real rename regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingCrisisCustomerActionsColumnDirectRestNoise(
      "column crisis_customer_actions.current_tail does not exist",
      "select current_tail from public.crisis_customer_actions",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingCrisisCustomerActionsColumnDirectRestNoise KEEPS a contract_id error on ANOTHER table (real regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingCrisisCustomerActionsColumnDirectRestNoise(
      "column crisis_events.contract_id does not exist",
      "select contract_id from public.crisis_events",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingCrisisCustomerActionsColumnDirectRestNoise KEEPS a non-SELECT statement / empty query (real code-bug shape still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingCrisisCustomerActionsColumnDirectRestNoise(
      "column crisis_customer_actions.contract_id does not exist",
      "insert into public.crisis_customer_actions (contract_id) values ('x')",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCrisisCustomerActionsColumnDirectRestNoise(
      "column crisis_customer_actions.contract_id does not exist",
      "update public.crisis_customer_actions set contract_id = 'x' where id = 1",
    ),
    false,
  );
  // A PostgREST INSERT inside the same CTE wrapper is a real code-write — stays paged.
  assert.equal(
    isForeignSupabasePostgresMissingCrisisCustomerActionsColumnDirectRestNoise(
      "column crisis_customer_actions.contract_id does not exist",
      'WITH pgrst_source AS (INSERT INTO "public"."crisis_customer_actions"("contract_id") VALUES ($1) RETURNING *)',
    ),
    false,
  );
  // Empty / missing query attribute — cannot confirm the SELECT-lookup shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingCrisisCustomerActionsColumnDirectRestNoise(
      "column crisis_customer_actions.contract_id does not exist",
      "",
    ),
    false,
  );
  // Empty / nullish message — need both markers.
  assert.equal(
    isForeignSupabasePostgresMissingCrisisCustomerActionsColumnDirectRestNoise(null, null),
    false,
  );
});
