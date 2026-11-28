/**
 * Unit tests for `isForeignSupabasePostgresUuidLikeOnCustomerLifecycleExperimentsIdAdhocNoise` —
 * the capture-time drop for foreign-app noise on Control Tower signature
 * `supabase-logs:a3e4adaac3bc5983`. Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.customer-lifecycle-experiments-id-uuid-like-noise.test.ts
 *
 * A Supabase Studio Table Editor quick-filter (or a direct-REST client) LIKE-filters the uuid
 * `customer_lifecycle_experiments.id` primary key, binding the filter value as text. Postgres has
 * no `uuid ~~ text` operator, so it rejects the query with `operator does not exist: uuid ~~
 * unknown` before any row is read. No ShopCX code path issues a `id LIKE` text match on
 * `customer_lifecycle_experiments` (a predeploy guard forbids LIKE on uuid columns), so the ERROR
 * is repair work for a query no code owns — the twin of the subscriptions / migration_audits /
 * tickets / returns uuid-LIKE siblings already dropped the same way. Drop AT CAPTURE only when
 * BOTH the exact operator-missing message AND a SELECT-shape on `customer_lifecycle_experiments`
 * with the `id like` marker (bare OR PostgREST CTE wrapper) are present. A non-SELECT on the
 * table, the same message on a different table, or a different operator error, must still page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresUuidLikeOnCustomerLifecycleExperimentsIdAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresUuidLikeOnCustomerLifecycleExperimentsIdAdhocNoise drops the captured supabase-logs:a3e4adaac3bc5983 customer_lifecycle_experiments.id probe", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact operator-missing message
  // from a `?id=like.*` direct-REST / Studio quick-filter LIKE of the uuid id on the table.
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnCustomerLifecycleExperimentsIdAdhocNoise(
      "operator does not exist: uuid ~~ unknown",
      'WITH pgrst_source AS ( SELECT "public"."customer_lifecycle_experiments".* FROM "public"."customer_lifecycle_experiments" WHERE "public"."customer_lifecycle_experiments"."id" LIKE $1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the exact-message check.
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnCustomerLifecycleExperimentsIdAdhocNoise(
      "ERROR: operator does not exist: uuid ~~ unknown",
      'WITH pgrst_source AS (SELECT "public"."customer_lifecycle_experiments"."id" FROM "public"."customer_lifecycle_experiments" WHERE "public"."customer_lifecycle_experiments"."id" LIKE $1)',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnCustomerLifecycleExperimentsIdAdhocNoise(
      "operator does not exist: uuid ~~ unknown",
      "select * from public.customer_lifecycle_experiments where id like '%abc%'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnCustomerLifecycleExperimentsIdAdhocNoise(
      "operator does not exist: uuid ~~ unknown",
      "select id from customer_lifecycle_experiments where id like $1",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnCustomerLifecycleExperimentsIdAdhocNoise(
      "operator does not exist: uuid ~~ unknown",
      "SELECT * FROM PUBLIC.CUSTOMER_LIFECYCLE_EXPERIMENTS WHERE ID LIKE $1",
    ),
    true,
  );
});

test("isForeignSupabasePostgresUuidLikeOnCustomerLifecycleExperimentsIdAdhocNoise KEEPS a different-operator / non-SELECT / other-table probe (real regressions still page)", () => {
  // A DIFFERENT operator-missing error on the same table (a real code bug with a different
  // operator mismatch) must still page.
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnCustomerLifecycleExperimentsIdAdhocNoise(
      "operator does not exist: integer = text",
      "select * from public.customer_lifecycle_experiments where id like $1",
    ),
    false,
  );
  // A non-SELECT statement against the table (real code-write shape) must still page — the pin is
  // the SELECT-lookup shape.
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnCustomerLifecycleExperimentsIdAdhocNoise(
      "operator does not exist: uuid ~~ unknown",
      "update public.customer_lifecycle_experiments set status = $1 where id like $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnCustomerLifecycleExperimentsIdAdhocNoise(
      "operator does not exist: uuid ~~ unknown",
      "insert into public.customer_lifecycle_experiments (id) values ($1)",
    ),
    false,
  );
  // The same uuid-LIKE message on a DIFFERENT table (a real code bug issuing a uuid LIKE
  // elsewhere) must still page.
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnCustomerLifecycleExperimentsIdAdhocNoise(
      "operator does not exist: uuid ~~ unknown",
      "select * from public.orders where id like $1",
    ),
    false,
  );
  // A SELECT on the table WITHOUT an `id like` marker (a different-column probe) must still page.
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnCustomerLifecycleExperimentsIdAdhocNoise(
      "operator does not exist: uuid ~~ unknown",
      "select * from public.customer_lifecycle_experiments where id = $1",
    ),
    false,
  );
  // Empty / absent message or query never drops.
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnCustomerLifecycleExperimentsIdAdhocNoise(
      "",
      "select * from customer_lifecycle_experiments where id like $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnCustomerLifecycleExperimentsIdAdhocNoise(
      "operator does not exist: uuid ~~ unknown",
      "",
    ),
    false,
  );
});
