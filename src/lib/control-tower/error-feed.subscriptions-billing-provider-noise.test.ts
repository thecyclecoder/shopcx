/**
 * Unit test for the `subscriptions.billing_provider` foreign-app noise-drop predicate
 * (scope-foreign-subscriptions-billing-provider-column-noise spec). Built-in node:test —
 * no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.subscriptions-billing-provider-noise.test.ts
 *
 * Our `subscriptions` table has NO `billing_provider` column — the billing provider /
 * origin of a subscription is captured by `billing_source` (+ `is_internal`); a bare
 * `billing_provider` column exists only in third-party subscription-app schemas, and no
 * ShopCX code path selects `subscriptions.billing_provider`. The message surfaces only when
 * a foreign / stale / manual client issues an ad hoc SELECT lookup. Drop AT CAPTURE only
 * when BOTH the exact column-missing message on `subscriptions.billing_provider` AND a
 * SELECT-lookup shape on `subscriptions` (bare OR PostgREST CTE wrapper) are present. A
 * column-missing on a live `subscriptions` column (`items`), on `billing_provider` from any
 * other table, or via a non-SELECT statement still pages (signature
 * supabase-logs:af1c5a78103832f6).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingSubscriptionsBillingProviderColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingSubscriptionsBillingProviderColumnAdhocNoise drops the canonical message on bare-SELECT + PostgREST CTE shapes", () => {
  // The captured production sample (signature supabase-logs:af1c5a78103832f6): a
  // PostgREST-wrapped SELECT + the exact column-missing message on
  // `subscriptions.billing_provider` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingProviderColumnAdhocNoise(
      "column subscriptions.billing_provider does not exist",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions"."id", "public"."subscriptions"."billing_provider" FROM "public"."subscriptions" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingProviderColumnAdhocNoise(
      "column public.subscriptions.billing_provider does not exist",
      'WITH pgrst_source AS (SELECT "public"."subscriptions"."billing_provider" FROM "public"."subscriptions")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingProviderColumnAdhocNoise(
      "column subscriptions.billing_provider does not exist",
      "select id, billing_provider from public.subscriptions",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingProviderColumnAdhocNoise(
      "column subscriptions.billing_provider does not exist",
      "select billing_provider from subscriptions limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingProviderColumnAdhocNoise(
      "ERROR: column subscriptions.billing_provider does not exist",
      'WITH pgrst_source AS (SELECT "public"."subscriptions"."billing_provider" FROM "public"."subscriptions")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionsBillingProviderColumnAdhocNoise KEEPS other columns / other tables / non-SELECT shapes / empty query (real regressions still page)", () => {
  // A DIFFERENT subscriptions column — `items` IS a live column; if it regresses we WANT
  // the page. The pin is `billing_provider` only.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingProviderColumnAdhocNoise(
      "column subscriptions.items does not exist",
      "select items from public.subscriptions",
    ),
    false,
  );
  // `billing_provider` on ANOTHER table — the pin is `subscriptions` only.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingProviderColumnAdhocNoise(
      "column orders.billing_provider does not exist",
      "select billing_provider from public.orders",
    ),
    false,
  );
  // A NON-SELECT statement on subscriptions — real code-bug shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingProviderColumnAdhocNoise(
      "column subscriptions.billing_provider does not exist",
      "delete from public.subscriptions where billing_provider = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingProviderColumnAdhocNoise(
      "column subscriptions.billing_provider does not exist",
      "update public.subscriptions set billing_provider = 'x' where id = 1",
    ),
    false,
  );
  // An empty / missing query attribute — cannot confirm the SELECT-lookup shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsBillingProviderColumnAdhocNoise(
      "column subscriptions.billing_provider does not exist",
      "",
    ),
    false,
  );
});
