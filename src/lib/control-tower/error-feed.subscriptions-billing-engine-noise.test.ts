/**
 * Unit test for the `subscriptions.billing_engine` foreign-app noise-drop predicate
 * (error-feed-drop-subscriptions-billing-engine-column-adhoc-noise spec). Built-in
 * node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.subscriptions-billing-engine-noise.test.ts
 *
 * Our `subscriptions` table has NO `billing_engine` column — the billing engine a
 * subscription runs on is captured by `is_internal` + `billing_source`, and no ShopCX code
 * path selects `subscriptions.billing_engine`. The message surfaces only when a foreign /
 * stale / manual client issues an ad hoc SELECT lookup. Drop AT CAPTURE only when BOTH the
 * exact column-missing message on `subscriptions.billing_engine` AND a SELECT-lookup shape
 * on `subscriptions` (bare OR PostgREST CTE wrapper) are present. A column-missing on a
 * live `subscriptions` column (`items`), on `billing_engine` from any other table, or via a
 * non-SELECT statement still pages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingSubscriptionsBillingEngineColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingSubscriptionsBillingEngineColumnAdhocNoise drops the canonical message on bare-SELECT + PostgREST CTE shapes", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-missing
  // message on `subscriptions.billing_engine` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingEngineColumnAdhocNoise(
      "column subscriptions.billing_engine does not exist",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions"."id", "public"."subscriptions"."billing_engine" FROM "public"."subscriptions" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingEngineColumnAdhocNoise(
      "column public.subscriptions.billing_engine does not exist",
      'WITH pgrst_source AS (SELECT "public"."subscriptions"."billing_engine" FROM "public"."subscriptions")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingEngineColumnAdhocNoise(
      "column subscriptions.billing_engine does not exist",
      "select id, billing_engine from public.subscriptions",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingEngineColumnAdhocNoise(
      "column subscriptions.billing_engine does not exist",
      "select billing_engine from subscriptions limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingEngineColumnAdhocNoise(
      "ERROR: column subscriptions.billing_engine does not exist",
      'WITH pgrst_source AS (SELECT "public"."subscriptions"."billing_engine" FROM "public"."subscriptions")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionsBillingEngineColumnAdhocNoise KEEPS other columns / other tables / non-SELECT shapes / empty query (real regressions still page)", () => {
  // A DIFFERENT subscriptions column — `items` IS a live column; if it regresses we WANT
  // the page. The pin is `billing_engine` only.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingEngineColumnAdhocNoise(
      "column subscriptions.items does not exist",
      "select items from public.subscriptions",
    ),
    false,
  );
  // `billing_engine` on ANOTHER table — the pin is `subscriptions` only.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingEngineColumnAdhocNoise(
      "column orders.billing_engine does not exist",
      "select billing_engine from public.orders",
    ),
    false,
  );
  // A NON-SELECT statement on subscriptions — real code-bug shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingEngineColumnAdhocNoise(
      "column subscriptions.billing_engine does not exist",
      "delete from public.subscriptions where billing_engine = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingEngineColumnAdhocNoise(
      "column subscriptions.billing_engine does not exist",
      "update public.subscriptions set billing_engine = 'x' where id = 1",
    ),
    false,
  );
  // An empty / missing query attribute — cannot confirm the SELECT-lookup shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingEngineColumnAdhocNoise(
      "column subscriptions.billing_engine does not exist",
      "",
    ),
    false,
  );
});
