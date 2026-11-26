/**
 * Unit tests for `isForeignSupabasePostgresInvalidUuidSyntaxOnSubscriptionsCustomerIdAdhocNoise` —
 * the capture-time drop for foreign-app noise on Control Tower signature
 * `supabase-logs:d9393a3e4f8314e2`. Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.subscriptions-customer-id-invalid-uuid-noise.test.ts
 *
 * A foreign / stale direct-REST client (or a Supabase Studio Table Editor quick-filter) reads
 * `/rest/v1/subscriptions?customer_id=eq.<non-uuid>` against our `public.subscriptions` table,
 * binding a hand-typed / truncated value to the uuid `customer_id` column. Postgres rejects the
 * literal at parse/bind time with `invalid input syntax for type uuid: "<garbage>"` before any row
 * is read, so no ShopCX code path produces it — every in-tree reader filters
 * `subscriptions.customer_id` with a well-formed uuid. This is the `customer_id` quick-filter twin
 * of the `subscriptions.id` sibling filter; the id-only classifier cannot match the customer_id
 * filter form, which is why this signature kept paging. Drop AT CAPTURE only when BOTH the exact
 * invalid-uuid message AND a SELECT-shape on `subscriptions` with a `customer_id = ` equality marker
 * (bare OR PostgREST CTE wrapper, plain `= $1` OR Studio `= ANY($1)`) are present. An UPDATE on
 * subscriptions, the same message on a different table, or a different message, must still page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresInvalidUuidSyntaxOnSubscriptionsCustomerIdAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresInvalidUuidSyntaxOnSubscriptionsCustomerIdAdhocNoise drops the captured supabase-logs:d9393a3e4f8314e2 subscriptions.customer_id probe", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact invalid-uuid message
  // from a `?customer_id=eq.<non-uuid>` direct-REST / Studio quick-filter read of public.subscriptions.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnSubscriptionsCustomerIdAdhocNoise(
      'invalid input syntax for type uuid: "cust-1042"',
      'WITH pgrst_source AS ( SELECT "public"."subscriptions".* FROM "public"."subscriptions" WHERE "public"."subscriptions"."customer_id" = $1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the startsWith check.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnSubscriptionsCustomerIdAdhocNoise(
      'ERROR: invalid input syntax for type uuid: "not-a-uuid"',
      'WITH pgrst_source AS (SELECT "public"."subscriptions"."id" FROM "public"."subscriptions" WHERE "public"."subscriptions"."customer_id" = $1)',
    ),
    true,
  );
  // The Studio `in` quick-filter emits a `customer_id = ANY($1)` predicate.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnSubscriptionsCustomerIdAdhocNoise(
      'invalid input syntax for type uuid: "abc"',
      'WITH pgrst_source AS ( SELECT "public"."subscriptions".* FROM "public"."subscriptions" WHERE "public"."subscriptions"."customer_id" = ANY($1) )',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnSubscriptionsCustomerIdAdhocNoise(
      'invalid input syntax for type uuid: "abc"',
      "select * from public.subscriptions where customer_id = $1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnSubscriptionsCustomerIdAdhocNoise(
      'invalid input syntax for type uuid: "abc"',
      "select id from subscriptions where subscriptions.customer_id = 'garbage'",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnSubscriptionsCustomerIdAdhocNoise(
      'invalid input syntax for type uuid: "XYZ"',
      "SELECT * FROM PUBLIC.SUBSCRIPTIONS WHERE CUSTOMER_ID = $1",
    ),
    true,
  );
});

test("isForeignSupabasePostgresInvalidUuidSyntaxOnSubscriptionsCustomerIdAdhocNoise KEEPS a non-SELECT / other-table / other-message (real regressions still page)", () => {
  // A non-SELECT statement against `subscriptions` (real code-write shape) must still page — the
  // pin is the SELECT-lookup shape.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnSubscriptionsCustomerIdAdhocNoise(
      'invalid input syntax for type uuid: "bad"',
      "update public.subscriptions set status = $1 where customer_id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnSubscriptionsCustomerIdAdhocNoise(
      'invalid input syntax for type uuid: "bad"',
      "delete from public.subscriptions where customer_id = $1",
    ),
    false,
  );
  // The same invalid-uuid message on a DIFFERENT table (a real code bug binding bad uuids
  // elsewhere) must still page.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnSubscriptionsCustomerIdAdhocNoise(
      'invalid input syntax for type uuid: "bad"',
      "select * from public.orders where customer_id = $1",
    ),
    false,
  );
  // A different message with a customer_id filter on subscriptions must still page.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnSubscriptionsCustomerIdAdhocNoise(
      "could not serialize access due to concurrent update",
      "select * from public.subscriptions where customer_id = $1",
    ),
    false,
  );
  // A SELECT on subscriptions WITHOUT a customer_id-equality marker (a different column probe) must
  // still page.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnSubscriptionsCustomerIdAdhocNoise(
      'invalid input syntax for type uuid: "bad"',
      "select * from public.subscriptions where id = $1",
    ),
    false,
  );
  // Empty / absent message or query never drops.
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnSubscriptionsCustomerIdAdhocNoise(
      "",
      "select * from subscriptions where customer_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresInvalidUuidSyntaxOnSubscriptionsCustomerIdAdhocNoise(
      'invalid input syntax for type uuid: "bad"',
      "",
    ),
    false,
  );
});
