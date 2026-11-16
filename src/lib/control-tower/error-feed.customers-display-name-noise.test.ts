/**
 * Unit tests for `isForeignSupabasePostgresMissingCustomersDisplayNameAdhocNoise` — the
 * capture-time drop for foreign-app noise on Control Tower signature
 * `supabase-logs:4125db0b44e76f83`. Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.customers-display-name-noise.test.ts
 *
 * An external-tool / Studio exploratory SELECT reads `display_name` from `public.customers`,
 * a column that table has never carried (user-facing names come from
 * `workspace_members.display_name`) and that no ShopCX code selects. Foreign-owned surface,
 * no lever from us — drop AT CAPTURE only when BOTH the exact column-missing message on
 * `customers.display_name` AND a SELECT-lookup shape on `customers` (bare OR PostgREST CTE
 * wrapper) are present. A column-missing on a different `customers` column, on `display_name`
 * from any other table, or via a non-SELECT statement still pages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingCustomersDisplayNameAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingCustomersDisplayNameAdhocNoise drops the captured supabase-logs:4125db0b44e76f83 message+query pair (PostgREST CTE + bare SELECT on customers.display_name)", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-missing
  // message on `customers.display_name` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingCustomersDisplayNameAdhocNoise(
      "column customers.display_name does not exist",
      'WITH pgrst_source AS ( SELECT "public"."customers"."id", "public"."customers"."display_name" FROM "public"."customers" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomersDisplayNameAdhocNoise(
      "column public.customers.display_name does not exist",
      'WITH pgrst_source AS (SELECT "public"."customers"."display_name" FROM "public"."customers")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingCustomersDisplayNameAdhocNoise(
      "column customers.display_name does not exist",
      "select id, display_name from public.customers",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomersDisplayNameAdhocNoise(
      "column customers.display_name does not exist",
      "select display_name from customers limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingCustomersDisplayNameAdhocNoise(
      "ERROR: column customers.display_name does not exist",
      'WITH pgrst_source AS (SELECT "public"."customers"."display_name" FROM "public"."customers")',
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingCustomersDisplayNameAdhocNoise(
      "column customers.display_name does not exist",
      "SELECT ID, DISPLAY_NAME FROM PUBLIC.CUSTOMERS",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingCustomersDisplayNameAdhocNoise KEEPS a column-missing on a different customers column, display_name on another table, and a non-SELECT statement (real regressions still page)", () => {
  // A column-missing on a DIFFERENT `customers` column (a real schema regression) must still
  // page — the pin is a bare `customers.display_name`.
  assert.equal(
    isForeignSupabasePostgresMissingCustomersDisplayNameAdhocNoise(
      "column customers.email does not exist",
      "select email from public.customers",
    ),
    false,
  );
  // A column-missing on `display_name` from a DIFFERENT table (e.g. where the column
  // legitimately lives — `workspace_members`) must still page.
  assert.equal(
    isForeignSupabasePostgresMissingCustomersDisplayNameAdhocNoise(
      "column workspace_members.display_name does not exist",
      "select display_name from public.workspace_members",
    ),
    false,
  );
  // A non-SELECT statement against `customers` (real code-bug shape) must still page — the
  // pin is the SELECT-lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingCustomersDisplayNameAdhocNoise(
      "column customers.display_name does not exist",
      "update public.customers set display_name = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomersDisplayNameAdhocNoise(
      "column customers.display_name does not exist",
      "delete from public.customers where display_name is null",
    ),
    false,
  );
  // Empty / absent message or query never drops.
  assert.equal(
    isForeignSupabasePostgresMissingCustomersDisplayNameAdhocNoise("", "select display_name from customers"),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomersDisplayNameAdhocNoise(
      "column customers.display_name does not exist",
      "",
    ),
    false,
  );
});
