/**
 * Dedicated unit tests for the `subscriptions.last_charged_at` foreign-app noise drop guard
 * (error-feed-drop-subscriptions-last-charged-at-direct-rest-no spec, Control Tower
 * signature `supabase-logs:f77b78ec44817af3`). Built-in node:test — no test-runner
 * dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.subscriptions-last-charged-at-noise.test.ts
 *
 * A foreign / stale PostgREST direct-REST client reads
 * `/rest/v1/subscriptions?select=...last_charged_at...` against our `public.subscriptions`
 * table. The table exists but has NO `last_charged_at` column — per-cycle charge history
 * lives in the separate `subscription_cycle_charges` table. Foreign-owned surface, no lever
 * from us — drop AT CAPTURE only when BOTH the exact column-missing message on
 * `subscriptions.last_charged_at` AND a SELECT-lookup shape on `subscriptions` (bare OR
 * PostgREST CTE wrapper) are present. A column-missing on a live `subscriptions` column
 * (`pause_resume_at`), on `last_charged_at` from any other table, or via a non-SELECT
 * statement still pages.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise drops the captured supabase-logs:f77b78ec44817af3 message+query pair (PostgREST CTE SELECT on subscriptions.last_charged_at)", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-missing
  // message on `subscriptions.last_charged_at` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise(
      "column subscriptions.last_charged_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions"."id", "public"."subscriptions"."last_charged_at" FROM "public"."subscriptions" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise(
      "column public.subscriptions.last_charged_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."subscriptions"."last_charged_at" FROM "public"."subscriptions")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise(
      "column subscriptions.last_charged_at does not exist",
      "select id, last_charged_at from public.subscriptions",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise(
      "column subscriptions.last_charged_at does not exist",
      "select last_charged_at from subscriptions limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise(
      "ERROR: column subscriptions.last_charged_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."subscriptions"."last_charged_at" FROM "public"."subscriptions")',
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise(
      "column subscriptions.last_charged_at does not exist",
      "SELECT ID, LAST_CHARGED_AT FROM PUBLIC.SUBSCRIPTIONS",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise KEEPS a column-missing on a live subscriptions column (pause_resume_at — a real schema regression still pages)", () => {
  // `pause_resume_at` IS a live column on `subscriptions`. If that ever regresses we WANT
  // the page — the pin is `subscriptions.last_charged_at` only.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise(
      "column subscriptions.pause_resume_at does not exist",
      "select pause_resume_at from public.subscriptions",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise(
      "column public.subscriptions.pause_resume_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions"."pause_resume_at" FROM "public"."subscriptions" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise KEEPS last_charged_at on ANOTHER table (the pin is subscriptions only)", () => {
  // `last_charged_at` missing on any other table is a different query we may well own — still page.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise(
      "column subscription_cycle_charges.last_charged_at does not exist",
      "select last_charged_at from public.subscription_cycle_charges",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise(
      "column customers.last_charged_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."customers"."last_charged_at" FROM "public"."customers" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise KEEPS a non-SELECT statement on subscriptions (INSERT/UPDATE is a real code-bug shape, still pages)", () => {
  // The pin is the SELECT-lookup shape. A write statement naming `last_charged_at` on
  // `subscriptions` would be OUR code — a genuine bug — so it must still page.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise(
      "column subscriptions.last_charged_at does not exist",
      "insert into public.subscriptions (last_charged_at) values (now())",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise(
      "column subscriptions.last_charged_at does not exist",
      "update public.subscriptions set last_charged_at = now() where id = '1'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise KEEPS when a marker is missing (empty message / empty query)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise(
      "",
      "select last_charged_at from public.subscriptions",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise(
      "column subscriptions.last_charged_at does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsLastChargedAtColumnAdhocNoise(null, null),
    false,
  );
});
