/**
 * Phase 1 of internal-renewal-skip-stale-attempts-before-dunning.
 *
 * Pins the stale-attempt boundary the guard at the top of the per-sub handler
 * uses. The cron fan-out stamps each attempt event with the sub's current
 * next_billing_date as `expected_next_billing_date`. When a duplicate/delayed
 * event arrives AFTER another attempt has already completed the cycle and
 * advanced the sub, the live next_billing_date won't match — the guard turns
 * that into a benign skip instead of re-charging + reopening dunning.
 *
 * Immediate-charge callers (portal order-now, appstle orderNowByContract,
 * payment-method recovery) intentionally send NO expected_next_billing_date;
 * the guard must leave them untouched.
 *
 * Pure function, no I/O — a direct import.
 *
 * Run:
 *   npx tsx --test src/lib/inngest/internal-subscription-renewals.stale-attempt.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isRenewalAttemptStale,
  lookupSubscriptionNextBillingDateForStaleGuard,
} from "./internal-subscription-renewals";

const T1 = "2026-08-09T00:00:00Z";
const T2 = "2026-09-09T00:00:00Z"; // one cycle later

test("Phase 1: matching expected + actual next_billing_date is NOT stale (the normal path)", () => {
  assert.equal(isRenewalAttemptStale(T1, T1), false);
});

test("Phase 1: a moved-forward next_billing_date IS stale (another attempt already advanced)", () => {
  assert.equal(isRenewalAttemptStale(T1, T2), true);
});

test("Phase 1: a moved-backward next_billing_date is ALSO stale (fail-closed on any move)", () => {
  assert.equal(isRenewalAttemptStale(T2, T1), true);
});

test("Phase 1: an event with NO expected_next_billing_date passes through (immediate-charge callers)", () => {
  assert.equal(isRenewalAttemptStale(null, T1), false);
  assert.equal(isRenewalAttemptStale(undefined, T1), false);
});

test("Phase 1: no live actual next_billing_date does NOT force stale (defensive — never over-hold)", () => {
  assert.equal(isRenewalAttemptStale(T1, null), false);
  assert.equal(isRenewalAttemptStale(T1, undefined), false);
});

test("Phase 1: unparseable date strings on either side pass through (never over-hold)", () => {
  assert.equal(isRenewalAttemptStale("not-a-date", T1), false);
  assert.equal(isRenewalAttemptStale(T1, "not-a-date"), false);
});

test("Phase 1: differing ISO representations of the SAME instant are NOT stale (equality by ms)", () => {
  // Same instant, different serialization
  assert.equal(
    isRenewalAttemptStale("2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00Z"),
    false,
  );
});

// ─── Tenant-scoped live read for the stale-attempt guard ───────────────
// The vulnerability closed here: without workspace_id in the WHERE clause a
// renewal-attempt event carrying { subscription_id: <foreign>, workspace_id:
// <attacker> } could read the foreign sub's next_billing_date and either
// surface it via `actual_next_billing_date` or suppress a legitimate charge
// path. Mock the admin's supabase-js chain (from().select().eq().eq().maybeSingle())
// and prove the workspace filter is applied.
type StoredSub = { id: string; workspace_id: string; next_billing_date: string | null };
function makeMockAdmin(subs: StoredSub[]) {
  return {
    from(_table: "subscriptions") {
      let filterId: string | null = null;
      let filterWs: string | null = null;
      const chain = {
        select(_cols: string) {
          return chain;
        },
        eq(col: string, val: string) {
          if (col === "id") filterId = val;
          if (col === "workspace_id") filterWs = val;
          return chain;
        },
        async maybeSingle() {
          const match = subs.find((s) => s.id === filterId && s.workspace_id === filterWs);
          return { data: match ? { next_billing_date: match.next_billing_date } : null };
        },
      };
      return chain;
    },
  };
}

test("Phase 1 (scope-to-workspace): same workspace + matching next_billing_date returns the live value (not stale)", async () => {
  const admin = makeMockAdmin([{ id: "sub-A", workspace_id: "ws-A", next_billing_date: T1 }]);
  const actual = await lookupSubscriptionNextBillingDateForStaleGuard(admin, "sub-A", "ws-A");
  assert.equal(actual, T1);
  assert.equal(isRenewalAttemptStale(T1, actual), false);
});

test("Phase 1 (scope-to-workspace): same workspace + moved next_billing_date returns the moved value (stale skip fires)", async () => {
  const admin = makeMockAdmin([{ id: "sub-A", workspace_id: "ws-A", next_billing_date: T2 }]);
  const actual = await lookupSubscriptionNextBillingDateForStaleGuard(admin, "sub-A", "ws-A");
  assert.equal(actual, T2);
  assert.equal(isRenewalAttemptStale(T1, actual), true);
});

test("Phase 1 (scope-to-workspace): mismatched workspace_id + real subscription_id returns null — no cross-tenant leak, no stale=true", async () => {
  const admin = makeMockAdmin([{ id: "sub-A", workspace_id: "ws-A", next_billing_date: T2 }]);
  const actual = await lookupSubscriptionNextBillingDateForStaleGuard(admin, "sub-A", "ws-B");
  assert.equal(actual, null); // the foreign sub's live billing date is NOT surfaced
  assert.equal(isRenewalAttemptStale(T1, actual), false); // and the guard cannot flip stale on foreign state
});

test("Phase 1 (scope-to-workspace): absent subscription_id returns null (fail-open — never over-hold)", async () => {
  const admin = makeMockAdmin([{ id: "sub-A", workspace_id: "ws-A", next_billing_date: T1 }]);
  const actual = await lookupSubscriptionNextBillingDateForStaleGuard(admin, "sub-does-not-exist", "ws-A");
  assert.equal(actual, null);
  assert.equal(isRenewalAttemptStale(T1, actual), false);
});
