/**
 * Unit tests for `isForeignSupabasePostgresMissingReturnsFreeLabelColumnAdhocNoise` — the
 * capture-time drop for foreign-app noise on Control Tower signature
 * `supabase-logs:4483f178db5fc145`. Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.returns-free-label-noise.test.ts
 *
 * A foreign / stale PostgREST direct-REST client reads `/rest/v1/returns?select=...free_label...`
 * against our `public.returns` table with a guessed, wrong column list. The table has
 * `label_url` (and `net_refund_cents`), never a bare `free_label` (nor a `refund_amount_cents`),
 * and no ShopCX code path names it. Foreign-owned surface, no lever from us — drop AT CAPTURE
 * only when BOTH the exact column-missing message on `returns.free_label` AND a SELECT-lookup
 * shape on `returns` (bare OR PostgREST CTE wrapper) are present. A column-missing on a
 * different `returns` column, on `free_label` from any other table, or via a non-SELECT
 * statement still pages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingReturnsFreeLabelColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingReturnsFreeLabelColumnAdhocNoise drops the captured supabase-logs:4483f178db5fc145 message+query pair (PostgREST CTE SELECT on returns.free_label)", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-missing
  // message on `returns.free_label` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingReturnsFreeLabelColumnAdhocNoise(
      "column returns.free_label does not exist",
      'WITH pgrst_source AS ( SELECT "public"."returns"."id", "public"."returns"."free_label" FROM "public"."returns" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingReturnsFreeLabelColumnAdhocNoise(
      "column public.returns.free_label does not exist",
      'WITH pgrst_source AS (SELECT "public"."returns"."free_label" FROM "public"."returns")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsFreeLabelColumnAdhocNoise(
      "column returns.free_label does not exist",
      "select id, free_label from public.returns",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingReturnsFreeLabelColumnAdhocNoise(
      "column returns.free_label does not exist",
      "select free_label from returns limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsFreeLabelColumnAdhocNoise(
      "ERROR: column returns.free_label does not exist",
      'WITH pgrst_source AS (SELECT "public"."returns"."free_label" FROM "public"."returns")',
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsFreeLabelColumnAdhocNoise(
      "column returns.free_label does not exist",
      "SELECT ID, FREE_LABEL FROM PUBLIC.RETURNS",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingReturnsFreeLabelColumnAdhocNoise KEEPS a column-missing on a different returns column, free_label on another table, and a non-SELECT statement (real regressions still page)", () => {
  // A column-missing on a DIFFERENT `returns` column (a real schema regression, including
  // the real `label_url`) must still page — the pin is a bare `returns.free_label`.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsFreeLabelColumnAdhocNoise(
      "column returns.label_url does not exist",
      "select label_url from public.returns",
    ),
    false,
  );
  // A column-missing on `free_label` from a DIFFERENT table must still page.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsFreeLabelColumnAdhocNoise(
      "column shipments.free_label does not exist",
      "select free_label from public.shipments",
    ),
    false,
  );
  // A non-SELECT statement against `returns` (real code-bug shape) must still page — the
  // pin is the SELECT-lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingReturnsFreeLabelColumnAdhocNoise(
      "column returns.free_label does not exist",
      "update public.returns set free_label = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingReturnsFreeLabelColumnAdhocNoise(
      "column returns.free_label does not exist",
      "delete from public.returns where free_label is null",
    ),
    false,
  );
  // Empty / absent message or query never drops.
  assert.equal(isForeignSupabasePostgresMissingReturnsFreeLabelColumnAdhocNoise("", "select free_label from returns"), false);
  assert.equal(
    isForeignSupabasePostgresMissingReturnsFreeLabelColumnAdhocNoise("column returns.free_label does not exist", ""),
    false,
  );
});
