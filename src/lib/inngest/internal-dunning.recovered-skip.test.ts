/**
 * Phase 1 of internal-dunning-skip-stale-failure-on-healthy-subscription.
 *
 * Pins the recovered-from-dunning boundary that `handleInternalDunningFailure`
 * uses BEFORE opening or advancing a cycle. A late/duplicate internal renewal
 * failure event whose live subscription is already `active`, has
 * last_payment_status='succeeded', and whose next_billing_date is safely in
 * the future must NOT reopen dunning — otherwise the Control Tower loop tile
 * `dunning-payday-retry-cron` goes red on a cycle nothing can clear.
 *
 * Also pins the tenant-scoped live read helper — a mismatched workspace_id
 * must never surface another workspace's next_billing_date/status, and an
 * absent sub must fail open (never over-skip a genuinely-due failure).
 *
 * Pure predicate + a mock-admin unit seam — no live Supabase I/O.
 *
 * Run:
 *   npx tsx --test src/lib/inngest/internal-dunning.recovered-skip.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isSubscriptionRecoveredFromDunning,
  lookupSubscriptionForDunningRecoveryGuard,
} from "./internal-dunning";

const NOW = new Date("2026-08-10T12:00:00Z").getTime();
const FUTURE = "2026-09-10T12:00:00Z"; // one cycle ahead
const PAST = "2026-07-10T12:00:00Z"; // one cycle behind

test("Phase 1: active + succeeded + future next_billing_date IS recovered (the skip path)", () => {
  assert.equal(
    isSubscriptionRecoveredFromDunning(
      { status: "active", last_payment_status: "succeeded", next_billing_date: FUTURE },
      NOW,
    ),
    true,
  );
});

test("Phase 1: active + succeeded + PAST next_billing_date is NOT recovered (genuinely due — enter dunning)", () => {
  assert.equal(
    isSubscriptionRecoveredFromDunning(
      { status: "active", last_payment_status: "succeeded", next_billing_date: PAST },
      NOW,
    ),
    false,
  );
});

test("Phase 1: active + succeeded + next_billing_date exactly = now is NOT recovered (strictly future)", () => {
  assert.equal(
    isSubscriptionRecoveredFromDunning(
      { status: "active", last_payment_status: "succeeded", next_billing_date: new Date(NOW).toISOString() },
      NOW,
    ),
    false,
  );
});

test("Phase 1: cancelled sub is NEVER recovered (the exhausted-then-cancelled path stays fair game)", () => {
  assert.equal(
    isSubscriptionRecoveredFromDunning(
      { status: "cancelled", last_payment_status: "succeeded", next_billing_date: FUTURE },
      NOW,
    ),
    false,
  );
});

test("Phase 1: paused / non-active status is NOT recovered", () => {
  assert.equal(
    isSubscriptionRecoveredFromDunning(
      { status: "paused", last_payment_status: "succeeded", next_billing_date: FUTURE },
      NOW,
    ),
    false,
  );
});

test("Phase 1: last_payment_status='failed' is NOT recovered (the failure is real, dunning must proceed)", () => {
  assert.equal(
    isSubscriptionRecoveredFromDunning(
      { status: "active", last_payment_status: "failed", next_billing_date: FUTURE },
      NOW,
    ),
    false,
  );
});

test("Phase 1: null last_payment_status is NOT recovered (unknown state → never over-skip)", () => {
  assert.equal(
    isSubscriptionRecoveredFromDunning(
      { status: "active", last_payment_status: null, next_billing_date: FUTURE },
      NOW,
    ),
    false,
  );
});

test("Phase 1: null next_billing_date is NOT recovered (nothing scheduled → can't prove future)", () => {
  assert.equal(
    isSubscriptionRecoveredFromDunning(
      { status: "active", last_payment_status: "succeeded", next_billing_date: null },
      NOW,
    ),
    false,
  );
});

test("Phase 1: unparseable next_billing_date is NOT recovered (defensive — never over-skip)", () => {
  assert.equal(
    isSubscriptionRecoveredFromDunning(
      { status: "active", last_payment_status: "succeeded", next_billing_date: "not-a-date" },
      NOW,
    ),
    false,
  );
});

test("Phase 1: null probe (no live row / cross-tenant mismatch) is NOT recovered — fail-open into dunning", () => {
  assert.equal(isSubscriptionRecoveredFromDunning(null, NOW), false);
  assert.equal(isSubscriptionRecoveredFromDunning(undefined, NOW), false);
});

// ─── Tenant-scoped live read for the recovered-from-dunning guard ───────
// The rail closed here: without workspace_id in the WHERE clause a dunning
// failure event carrying { subscription_id: <foreign>, workspace_id:
// <attacker> } could read the foreign sub's status/next_billing_date and
// either surface it or flip the guard into skipping a legitimate charge
// path. Mock the admin's supabase-js chain and prove the workspace filter
// is applied.
type StoredSub = {
  id: string;
  workspace_id: string;
  status: string;
  last_payment_status: string;
  next_billing_date: string;
};
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
          const match = subs.find(
            (s) => s.id === filterId && s.workspace_id === filterWs,
          );
          return {
            data: match
              ? {
                  status: match.status,
                  last_payment_status: match.last_payment_status,
                  next_billing_date: match.next_billing_date,
                }
              : null,
          };
        },
      };
      return chain;
    },
  };
}

test("Phase 1 (scope-to-workspace): same workspace + recovered sub returns the live probe (skip fires)", async () => {
  const admin = makeMockAdmin([
    {
      id: "sub-A",
      workspace_id: "ws-A",
      status: "active",
      last_payment_status: "succeeded",
      next_billing_date: FUTURE,
    },
  ]);
  const probe = await lookupSubscriptionForDunningRecoveryGuard(admin, "sub-A", "ws-A");
  assert.equal(probe?.status, "active");
  assert.equal(probe?.last_payment_status, "succeeded");
  assert.equal(probe?.next_billing_date, FUTURE);
  assert.equal(isSubscriptionRecoveredFromDunning(probe, NOW), true);
});

test("Phase 1 (scope-to-workspace): mismatched workspace_id + real subscription_id returns null — no cross-tenant probe leak, no false skip", async () => {
  const admin = makeMockAdmin([
    {
      id: "sub-A",
      workspace_id: "ws-A",
      status: "active",
      last_payment_status: "succeeded",
      next_billing_date: FUTURE,
    },
  ]);
  const probe = await lookupSubscriptionForDunningRecoveryGuard(admin, "sub-A", "ws-B");
  assert.equal(probe, null);
  assert.equal(isSubscriptionRecoveredFromDunning(probe, NOW), false);
});

test("Phase 1 (scope-to-workspace): absent subscription_id returns null (fail-open — genuinely-due failure still enters dunning)", async () => {
  const admin = makeMockAdmin([
    {
      id: "sub-A",
      workspace_id: "ws-A",
      status: "active",
      last_payment_status: "succeeded",
      next_billing_date: FUTURE,
    },
  ]);
  const probe = await lookupSubscriptionForDunningRecoveryGuard(admin, "sub-does-not-exist", "ws-A");
  assert.equal(probe, null);
  assert.equal(isSubscriptionRecoveredFromDunning(probe, NOW), false);
});
