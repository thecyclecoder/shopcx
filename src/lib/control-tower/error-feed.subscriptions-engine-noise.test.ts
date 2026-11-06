/**
 * Unit test for the `subscriptions.engine` foreign-app noise-drop predicate
 * (error-feed-drop-subscriptions-engine-column-adhoc-noise spec). Built-in node:test —
 * no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.subscriptions-engine-noise.test.ts
 *
 * Our `subscriptions` table has NO `engine` column — the engine a subscription runs on is
 * captured by `is_internal` + `billing_source`, and no ShopCX code path selects
 * `subscriptions.engine`. The message surfaces only when a foreign / stale / manual client
 * issues an ad hoc SELECT lookup. Drop AT CAPTURE only when BOTH the exact column-missing
 * message on `subscriptions.engine` AND a SELECT-lookup shape on `subscriptions` (bare OR
 * PostgREST CTE wrapper) are present. A column-missing on a live `subscriptions` column
 * (`items`), on `engine` from any other table, or via a non-SELECT statement still pages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingSubscriptionsEngineColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingSubscriptionsEngineColumnAdhocNoise drops the canonical message on bare-SELECT + PostgREST CTE shapes", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-missing
  // message on `subscriptions.engine` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsEngineColumnAdhocNoise(
      "column subscriptions.engine does not exist",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions"."id", "public"."subscriptions"."engine" FROM "public"."subscriptions" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsEngineColumnAdhocNoise(
      "column public.subscriptions.engine does not exist",
      'WITH pgrst_source AS (SELECT "public"."subscriptions"."engine" FROM "public"."subscriptions")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsEngineColumnAdhocNoise(
      "column subscriptions.engine does not exist",
      "select id, engine from public.subscriptions",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsEngineColumnAdhocNoise(
      "column subscriptions.engine does not exist",
      "select engine from subscriptions limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsEngineColumnAdhocNoise(
      "ERROR: column subscriptions.engine does not exist",
      'WITH pgrst_source AS (SELECT "public"."subscriptions"."engine" FROM "public"."subscriptions")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionsEngineColumnAdhocNoise KEEPS other columns / non-SELECT shapes / empty query (real regressions still page)", () => {
  // A DIFFERENT subscriptions column — `items` IS a live column; if it regresses we WANT
  // the page. The pin is `engine` only.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsEngineColumnAdhocNoise(
      "column subscriptions.items does not exist",
      "select items from public.subscriptions",
    ),
    false,
  );
  // A NON-SELECT statement on subscriptions — real code-bug shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsEngineColumnAdhocNoise(
      "column subscriptions.engine does not exist",
      "delete from public.subscriptions where engine = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsEngineColumnAdhocNoise(
      "column subscriptions.engine does not exist",
      "update public.subscriptions set engine = 'x' where id = 1",
    ),
    false,
  );
  // An empty / missing query attribute — cannot confirm the SELECT-lookup shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsEngineColumnAdhocNoise(
      "column subscriptions.engine does not exist",
      "",
    ),
    false,
  );
});
