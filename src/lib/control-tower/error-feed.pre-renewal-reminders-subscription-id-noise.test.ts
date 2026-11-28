/**
 * Unit tests for the capture-time foreign-app-noise drop of the
 * `column pre_renewal_reminders.subscription_id does not exist` Postgres undefined_column
 * error. Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.pre-renewal-reminders-subscription-id-noise.test.ts
 *
 * A foreign / stale PostgREST direct-REST client reads
 * `/rest/v1/pre_renewal_reminders?select=...subscription_id...` against our
 * `public.pre_renewal_reminders` table. The table exists but has NO `subscription_id`
 * column — its grain is the customer identity GROUP (group_id / customer_id), never a
 * per-subscription id. Foreign-owned surface, no lever from us — drop AT CAPTURE only when
 * BOTH the exact column-missing message on `pre_renewal_reminders.subscription_id` AND a
 * SELECT-lookup shape on `pre_renewal_reminders` (bare OR PostgREST CTE wrapper) are present.
 * A column-missing on a different column, a different table, or a non-SELECT statement still
 * pages. Control Tower signature `supabase-logs:fc34a27a1d24f525`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingPreRenewalRemindersSubscriptionIdColumnAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingPreRenewalRemindersSubscriptionIdColumnAdhocNoise drops the captured supabase-logs:fc34a27a1d24f525 message+query pair (PostgREST CTE SELECT on pre_renewal_reminders.subscription_id)", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-missing
  // message on `pre_renewal_reminders.subscription_id` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingPreRenewalRemindersSubscriptionIdColumnAdhocNoise(
      "column pre_renewal_reminders.subscription_id does not exist",
      'WITH pgrst_source AS ( SELECT "public"."pre_renewal_reminders"."id", "public"."pre_renewal_reminders"."subscription_id" FROM "public"."pre_renewal_reminders" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPreRenewalRemindersSubscriptionIdColumnAdhocNoise(
      "column public.pre_renewal_reminders.subscription_id does not exist",
      'WITH pgrst_source AS (SELECT "public"."pre_renewal_reminders"."subscription_id" FROM "public"."pre_renewal_reminders")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingPreRenewalRemindersSubscriptionIdColumnAdhocNoise(
      "column pre_renewal_reminders.subscription_id does not exist",
      "select id, subscription_id from public.pre_renewal_reminders",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPreRenewalRemindersSubscriptionIdColumnAdhocNoise(
      "column pre_renewal_reminders.subscription_id does not exist",
      "select subscription_id from pre_renewal_reminders limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingPreRenewalRemindersSubscriptionIdColumnAdhocNoise(
      "ERROR: column pre_renewal_reminders.subscription_id does not exist",
      'WITH pgrst_source AS (SELECT "public"."pre_renewal_reminders"."subscription_id" FROM "public"."pre_renewal_reminders")',
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingPreRenewalRemindersSubscriptionIdColumnAdhocNoise(
      "column pre_renewal_reminders.subscription_id does not exist",
      "SELECT ID, SUBSCRIPTION_ID FROM PUBLIC.PRE_RENEWAL_REMINDERS",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingPreRenewalRemindersSubscriptionIdColumnAdhocNoise KEEPS other columns / tables / non-SELECT shapes (real regressions still page)", () => {
  // A DIFFERENT pre_renewal_reminders column — a real regression on a live column we WANT
  // to page on. The pin is `subscription_id` only.
  assert.equal(
    isForeignSupabasePostgresMissingPreRenewalRemindersSubscriptionIdColumnAdhocNoise(
      "column pre_renewal_reminders.group_id does not exist",
      "select group_id from public.pre_renewal_reminders",
    ),
    false,
  );
  // `subscription_id` on ANOTHER table — not our pinned signature, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingPreRenewalRemindersSubscriptionIdColumnAdhocNoise(
      "column subscription_cycle_charges.subscription_id does not exist",
      "select subscription_id from public.subscription_cycle_charges",
    ),
    false,
  );
  // A NON-SELECT statement on pre_renewal_reminders — real code-bug shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingPreRenewalRemindersSubscriptionIdColumnAdhocNoise(
      "column pre_renewal_reminders.subscription_id does not exist",
      "update public.pre_renewal_reminders set subscription_id = 1 where id = 1",
    ),
    false,
  );
  // Empty / missing inputs are never noise.
  assert.equal(
    isForeignSupabasePostgresMissingPreRenewalRemindersSubscriptionIdColumnAdhocNoise(null, null),
    false,
  );
});
