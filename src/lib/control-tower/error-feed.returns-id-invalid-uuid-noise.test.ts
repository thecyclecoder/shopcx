/**
 * Unit tests for `isForeignSupabasePostgresInvalidUuidSyntaxOnReturnsIdAdhocNoise` — the
 * capture-time drop for foreign-app noise on Control Tower signature
 * `supabase-logs:d9393a3e4f8314e2`. Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.returns-id-invalid-uuid-noise.test.ts
 *
 * A foreign / stale direct-REST client (or a Supabase Studio Table Editor quick-filter) reads
 * `/rest/v1/returns?id=eq.<non-uuid>` against our `public.returns` table, binding a hand-typed /
 * truncated value to the uuid primary key. Postgres rejects the literal at parse/bind time with
 * `invalid input syntax for type uuid: "<garbage>"` before any row is read, so no ShopCX code
 * path produces it — every in-tree reader filters `returns.id` with a well-formed uuid. This is
 * the equality-form twin of the uuid-LIKE sibling filters on `returns.id`. Drop AT CAPTURE only
 * when BOTH the exact invalid-uuid message AND a SELECT-shape on `returns` with an `id = ` equality
 * marker (bare OR PostgREST CTE wrapper) are present. An UPDATE on returns, or the same message on
 * a different table, must still page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresInvalidUuidSyntaxOnReturnsIdAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresInvalidUuidSyntaxOnReturnsIdAdhocNoise drops the captured supabase-logs:d9393a3e4f8314e2 returns.id equality probe", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact invalid-uuid message
  // from a `?id=eq.<non-uuid>` direct-REST read of public.returns.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnReturnsIdAdhocNoise(
      'invalid input syntax for type uuid: "RET-1042"',
      'WITH pgrst_source AS ( SELECT "public"."returns".* FROM "public"."returns" WHERE "public"."returns"."id" = $1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the startsWith check.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnReturnsIdAdhocNoise(
      'ERROR: invalid input syntax for type uuid: "not-a-uuid"',
      'WITH pgrst_source AS (SELECT "public"."returns"."id" FROM "public"."returns" WHERE "public"."returns"."id" = $1)',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnReturnsIdAdhocNoise(
      'invalid input syntax for type uuid: "abc"',
      "select * from public.returns where id = $1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnReturnsIdAdhocNoise(
      'invalid input syntax for type uuid: "abc"',
      "select id from returns where returns.id = 'garbage'",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnReturnsIdAdhocNoise(
      'invalid input syntax for type uuid: "XYZ"',
      "SELECT * FROM PUBLIC.RETURNS WHERE ID = $1",
    ),
    true,
  );
});

test("isForeignSupabasePostgresInvalidUuidSyntaxOnReturnsIdAdhocNoise KEEPS an UPDATE on returns and the same message on a different table (real regressions still page)", () => {
  // A non-SELECT statement against `returns` (real code-write shape) must still page — the pin
  // is the SELECT-lookup shape.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnReturnsIdAdhocNoise(
      'invalid input syntax for type uuid: "bad"',
      "update public.returns set status = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnReturnsIdAdhocNoise(
      'invalid input syntax for type uuid: "bad"',
      "delete from public.returns where id = $1",
    ),
    false,
  );
  // The same invalid-uuid message on a DIFFERENT table (a real code bug binding bad uuids
  // elsewhere) must still page.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnReturnsIdAdhocNoise(
      'invalid input syntax for type uuid: "bad"',
      "select * from public.tickets where id = $1",
    ),
    false,
  );
  // A SELECT on returns WITHOUT an id-equality marker (a different column probe) must still page.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnReturnsIdAdhocNoise(
      'invalid input syntax for type uuid: "bad"',
      "select * from public.returns where customer_id = $1",
    ),
    false,
  );
  // A different message on a returns.id SELECT must still page.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnReturnsIdAdhocNoise(
      "could not serialize access due to concurrent update",
      "select * from public.returns where id = $1",
    ),
    false,
  );
  // Empty / absent message or query never drops.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnReturnsIdAdhocNoise("", "select * from returns where id = $1"),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnReturnsIdAdhocNoise(
      'invalid input syntax for type uuid: "bad"',
      "",
    ),
    false,
  );
});
