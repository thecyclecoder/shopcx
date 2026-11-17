/**
 * Unit test for the `subscriptions.source` foreign-app noise-drop predicate
 * (error-feed-drop-subscriptions-source-column-adhoc-noise spec). Built-in node:test —
 * no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.subscriptions-source-noise.test.ts
 *
 * Our `subscriptions` table has NO `source` column — where a subscription originated is
 * captured by `is_internal` + `billing_source`, a bare `source` column exists only in
 * third-party subscription-app schemas, and no ShopCX code path selects
 * `subscriptions.source`. The message surfaces only when a foreign / stale / manual client
 * issues an ad hoc SELECT lookup. Drop AT CAPTURE only when BOTH the exact column-missing
 * message on `subscriptions.source` AND a SELECT-lookup shape on `subscriptions` (bare OR
 * PostgREST CTE wrapper) are present. A column-missing on a live `subscriptions` column
 * (`items`), on `source` from any other table, or via a non-SELECT statement still pages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingSubscriptionsSourceColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingSubscriptionsSourceColumnAdhocNoise drops the canonical message on bare-SELECT + PostgREST CTE shapes", () => {
  // The captured production sample (signature supabase-logs:508252dfdf040087):
  // PostgREST-wrapped SELECT + the exact column-missing message on `subscriptions.source`
  // (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsSourceColumnAdhocNoise(
      "column subscriptions.source does not exist",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions"."id", "public"."subscriptions"."source" FROM "public"."subscriptions" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsSourceColumnAdhocNoise(
      "column public.subscriptions.source does not exist",
      'WITH pgrst_source AS (SELECT "public"."subscriptions"."source" FROM "public"."subscriptions")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsSourceColumnAdhocNoise(
      "column subscriptions.source does not exist",
      "select id, source from public.subscriptions",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsSourceColumnAdhocNoise(
      "column subscriptions.source does not exist",
      "select source from subscriptions limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsSourceColumnAdhocNoise(
      "ERROR: column subscriptions.source does not exist",
      'WITH pgrst_source AS (SELECT "public"."subscriptions"."source" FROM "public"."subscriptions")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionsSourceColumnAdhocNoise KEEPS other columns / other tables / non-SELECT shapes / empty query (real regressions still page)", () => {
  // A DIFFERENT subscriptions column — `items` IS a live column; if it regresses we WANT
  // the page. The pin is `source` only.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsSourceColumnAdhocNoise(
      "column subscriptions.items does not exist",
      "select items from public.subscriptions",
    ),
    false,
  );
  // `source` on ANOTHER table — the pin is `subscriptions` only.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsSourceColumnAdhocNoise(
      "column orders.source does not exist",
      "select source from public.orders",
    ),
    false,
  );
  // A NON-SELECT statement on subscriptions — real code-bug shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsSourceColumnAdhocNoise(
      "column subscriptions.source does not exist",
      "delete from public.subscriptions where source = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsSourceColumnAdhocNoise(
      "column subscriptions.source does not exist",
      "update public.subscriptions set source = 'x' where id = 1",
    ),
    false,
  );
  // An empty / missing query attribute — cannot confirm the SELECT-lookup shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsSourceColumnAdhocNoise(
      "column subscriptions.source does not exist",
      "",
    ),
    false,
  );
});
