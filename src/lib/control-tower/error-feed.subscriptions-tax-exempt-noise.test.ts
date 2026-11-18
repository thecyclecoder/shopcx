/**
 * Dedicated unit tests for the `subscriptions.tax_exempt` foreign-app noise drop guard
 * (error-feed-drop-subscriptions-tax-exempt-column-adhoc-noise spec, Control Tower
 * signature `supabase-logs:b37d78bd56a6f274`). Built-in node:test — no test-runner
 * dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.subscriptions-tax-exempt-noise.test.ts
 *
 * A foreign / stale PostgREST direct-REST client reads
 * `/rest/v1/subscriptions?select=...tax_exempt...` against our `public.subscriptions`
 * table. The table exists but has NO `tax_exempt` column — tax-exempt state lives in the
 * separate `customer_tax_exemptions` table. Foreign-owned surface, no lever from us — drop
 * AT CAPTURE only when BOTH the exact column-missing message on `subscriptions.tax_exempt`
 * AND a SELECT-lookup shape on `subscriptions` (bare OR PostgREST CTE wrapper) are present.
 * A column-missing on a live `subscriptions` column (`pause_resume_at`), on `tax_exempt`
 * from any other table, or via a non-SELECT statement still pages.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise drops the captured supabase-logs:b37d78bd56a6f274 message+query pair (PostgREST CTE SELECT on subscriptions.tax_exempt)", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-missing
  // message on `subscriptions.tax_exempt` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise(
      "column subscriptions.tax_exempt does not exist",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions"."id", "public"."subscriptions"."tax_exempt" FROM "public"."subscriptions" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise(
      "column public.subscriptions.tax_exempt does not exist",
      'WITH pgrst_source AS (SELECT "public"."subscriptions"."tax_exempt" FROM "public"."subscriptions")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise(
      "column subscriptions.tax_exempt does not exist",
      "select id, tax_exempt from public.subscriptions",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise(
      "column subscriptions.tax_exempt does not exist",
      "select tax_exempt from subscriptions limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise(
      "ERROR: column subscriptions.tax_exempt does not exist",
      'WITH pgrst_source AS (SELECT "public"."subscriptions"."tax_exempt" FROM "public"."subscriptions")',
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise(
      "column subscriptions.tax_exempt does not exist",
      "SELECT ID, TAX_EXEMPT FROM PUBLIC.SUBSCRIPTIONS",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise KEEPS a column-missing on a live subscriptions column (pause_resume_at — a real schema regression still pages)", () => {
  // `pause_resume_at` IS a live column on `subscriptions`. If that ever regresses we WANT
  // the page — the pin is `subscriptions.tax_exempt` only.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise(
      "column subscriptions.pause_resume_at does not exist",
      "select pause_resume_at from public.subscriptions",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise(
      "column public.subscriptions.pause_resume_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions"."pause_resume_at" FROM "public"."subscriptions" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise KEEPS tax_exempt on ANOTHER table (the pin is subscriptions only)", () => {
  // `tax_exempt` missing on any other table is a different query we may well own — still page.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise(
      "column customers.tax_exempt does not exist",
      "select tax_exempt from public.customers",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise(
      "column customer_tax_exemptions.tax_exempt does not exist",
      'WITH pgrst_source AS ( SELECT "public"."customer_tax_exemptions"."tax_exempt" FROM "public"."customer_tax_exemptions" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise KEEPS a non-SELECT statement on subscriptions (INSERT/UPDATE is a real code-bug shape, still pages)", () => {
  // The pin is the SELECT-lookup shape. A write statement naming `tax_exempt` on
  // `subscriptions` would be OUR code — a genuine bug — so it must still page.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise(
      "column subscriptions.tax_exempt does not exist",
      "insert into public.subscriptions (tax_exempt) values (true)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise(
      "column subscriptions.tax_exempt does not exist",
      "update public.subscriptions set tax_exempt = true where id = '1'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise KEEPS when a marker is missing (empty message / empty query)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise(
      "",
      "select tax_exempt from public.subscriptions",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise(
      "column subscriptions.tax_exempt does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsTaxExemptColumnAdhocNoise(null, null),
    false,
  );
});
