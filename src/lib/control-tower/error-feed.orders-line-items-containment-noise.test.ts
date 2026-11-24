/**
 * Unit tests for `isForeignSupabasePostgresOrdersLineItemsContainmentInvalidJsonAdhocNoise` —
 * the capture-time noise-drop for a foreign/stale direct-REST client passing a non-JSON value
 * to an `orders?line_items=cs.<value>` containment filter, producing Postgres
 * `invalid input syntax for type json` (Control Tower signature
 * `supabase-logs:dbe2c7bfb3216740`). The direct twin of the subscriptions-items classifier.
 * Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.orders-line-items-containment-noise.test.ts
 *
 * The predicate must DROP the captured orders `line_items @>` CTE sample (bare + ERROR-prefixed),
 * and KEEP (page on) the same message on a different orders column/operator, on another table,
 * and on a non-SELECT (INSERT / UPDATE) wrapper.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresOrdersLineItemsContainmentInvalidJsonAdhocNoise } from "./error-feed";

test("drops the orders line_items @> containment CTE shape (bare + ERROR-prefixed)", () => {
  assert.equal(
    isForeignSupabasePostgresOrdersLineItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'WITH pgrst_source AS ( SELECT "public"."orders".* FROM "public"."orders" WHERE "public"."orders"."line_items" @> $1 ) SELECT * FROM pgrst_source',
    ),
    true,
  );
  // Leading `ERROR: ` prefix Postgres includes on the logs surface is stripped.
  assert.equal(
    isForeignSupabasePostgresOrdersLineItemsContainmentInvalidJsonAdhocNoise(
      "ERROR: invalid input syntax for type json",
      'with pgrst_source as ( select "public"."orders"."id" from "public"."orders" where "public"."orders"."line_items" @> \'notjson\' ) select * from pgrst_source',
    ),
    true,
  );
});

test("KEEPS the same message on a DIFFERENT orders column (a real JSON bug still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresOrdersLineItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'with pgrst_source as ( select * from "public"."orders" where "public"."orders"."metadata" @> $1 ) select * from pgrst_source',
    ),
    false,
  );
});

test("KEEPS the same message on orders with a DIFFERENT JSONB operator (not @>)", () => {
  assert.equal(
    isForeignSupabasePostgresOrdersLineItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'with pgrst_source as ( select * from "public"."orders" where "public"."orders"."line_items" ->> $1 = $2 ) select * from pgrst_source',
    ),
    false,
  );
});

test("KEEPS the same line_items @> message on a DIFFERENT table (a real JSON bug still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresOrdersLineItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'with pgrst_source as ( select * from "public"."subscriptions" where "public"."subscriptions"."line_items" @> $1 ) select * from pgrst_source',
    ),
    false,
  );
});

test("KEEPS a non-SELECT PostgREST wrapper on orders (a real code-bug write still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresOrdersLineItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'with pgrst_source as ( insert into "public"."orders" ("line_items") values ($1) returning * ) select * from pgrst_source',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresOrdersLineItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'with pgrst_source as ( update "public"."orders" set "line_items" = $1 where "line_items" @> $2 ) select * from pgrst_source',
    ),
    false,
  );
});

test("KEEPS a different Postgres error on the orders line_items shape (not the bad-JSON message)", () => {
  assert.equal(
    isForeignSupabasePostgresOrdersLineItemsContainmentInvalidJsonAdhocNoise(
      "FATAL: terminating connection due to administrator command",
      'with pgrst_source as ( select * from "public"."orders" where "public"."orders"."line_items" @> $1 ) select * from pgrst_source',
    ),
    false,
  );
});

test("returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresOrdersLineItemsContainmentInvalidJsonAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresOrdersLineItemsContainmentInvalidJsonAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresOrdersLineItemsContainmentInvalidJsonAdhocNoise("", ""),
    false,
  );
  // Message matches but the query is empty — we need both markers.
  assert.equal(
    isForeignSupabasePostgresOrdersLineItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      "",
    ),
    false,
  );
});
