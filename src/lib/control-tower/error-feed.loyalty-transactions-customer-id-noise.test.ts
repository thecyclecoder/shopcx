/**
 * Unit tests for `isForeignSupabasePostgresMissingLoyaltyTransactionsCustomerIdColumnNoise` —
 * the capture-time drop for foreign-app noise on Control Tower signature
 * `supabase-logs:3c76f3fab04b4b69`. Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.loyalty-transactions-customer-id-noise.test.ts
 *
 * A foreign / stale direct-REST client reads `public.loyalty_transactions` by `customer_id`, a
 * column the ledger has never owned — it is keyed by `member_id`; `customer_id` lives on the
 * sibling `loyalty_members` table. Foreign-owned surface, no lever from us — drop AT CAPTURE
 * only when BOTH the exact column-missing message on `loyalty_transactions.customer_id` AND a
 * SELECT-lookup shape on `loyalty_transactions` (bare OR PostgREST CTE wrapper) are present. A
 * column-missing on a different column, on another table, or via a non-SELECT statement still
 * pages. Mirrors the `loyalty_redemptions.customer_id` twin.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingLoyaltyTransactionsCustomerIdColumnNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingLoyaltyTransactionsCustomerIdColumnNoise drops the PostgREST CTE wrapper + bare SELECT listing the non-existent customer_id column", () => {
  // The captured incident shape: a stale direct-REST client lists loyalty_transactions filtered
  // by customer_id, PostgREST wraps it as a `WITH pgrst_source AS ( SELECT ... FROM
  // "public"."loyalty_transactions" ... )` CTE, and Postgres rejects with the column-missing.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyTransactionsCustomerIdColumnNoise(
      "column loyalty_transactions.customer_id does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loyalty_transactions"."id", "public"."loyalty_transactions"."customer_id" FROM "public"."loyalty_transactions" WHERE "public"."loyalty_transactions"."customer_id" = $1 LIMIT $2 OFFSET $3 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyTransactionsCustomerIdColumnNoise(
      "column public.loyalty_transactions.customer_id does not exist",
      'with pgrst_source as ( select "public"."loyalty_transactions"."customer_id" from "public"."loyalty_transactions" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyTransactionsCustomerIdColumnNoise(
      "ERROR: column loyalty_transactions.customer_id does not exist",
      'WITH pgrst_source AS ( SELECT "customer_id" FROM "public"."loyalty_transactions" )',
    ),
    true,
  );
  // The bare SELECT form (not a PostgREST wrapper), qualified and unqualified FROM, drops.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyTransactionsCustomerIdColumnNoise(
      "column loyalty_transactions.customer_id does not exist",
      "select id, customer_id from public.loyalty_transactions where customer_id = $1 limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyTransactionsCustomerIdColumnNoise(
      "column loyalty_transactions.customer_id does not exist",
      "select * from loyalty_transactions where customer_id is not null",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingLoyaltyTransactionsCustomerIdColumnNoise KEEPS real errors (other table, other column, customer_id on loyalty_members, non-SELECT, FATAL)", () => {
  // Same customer_id-missing message on a DIFFERENT relation is a real product-schema
  // regression and still pages — the pin names loyalty_transactions only.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyTransactionsCustomerIdColumnNoise(
      "column tickets.customer_id does not exist",
      "select id, customer_id from public.tickets",
    ),
    false,
  );
  // A DIFFERENT column on loyalty_transactions (a real column rename / schema regression) still
  // pages — the pin is customer_id only.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyTransactionsCustomerIdColumnNoise(
      "column loyalty_transactions.member_id does not exist",
      "select id, member_id from public.loyalty_transactions",
    ),
    false,
  );
  // customer_id on the sibling loyalty_members table (where the column legitimately lives) is a
  // real regression and still pages — the pin names loyalty_transactions only.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyTransactionsCustomerIdColumnNoise(
      "column loyalty_members.customer_id does not exist",
      "select id, customer_id from public.loyalty_members",
    ),
    false,
  );
  // A non-SELECT shape (PostgREST CTE write / bare write) is a real code-bug and still pages.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyTransactionsCustomerIdColumnNoise(
      "column loyalty_transactions.customer_id does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."loyalty_transactions"("id","customer_id") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyTransactionsCustomerIdColumnNoise(
      "column loyalty_transactions.customer_id does not exist",
      "update public.loyalty_transactions set customer_id = $1 where id = $2",
    ),
    false,
  );
  // A FATAL / constraint-class error on the same shape is untouched (different message).
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyTransactionsCustomerIdColumnNoise(
      "FATAL: terminating connection due to administrator command",
      "select id, customer_id from public.loyalty_transactions",
    ),
    false,
  );
  // Empty / nullish message or query returns false — we need both markers.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyTransactionsCustomerIdColumnNoise("", "select * from loyalty_transactions"),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyTransactionsCustomerIdColumnNoise(
      "column loyalty_transactions.customer_id does not exist",
      "",
    ),
    false,
  );
});
