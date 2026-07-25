/**
 * Phase-2 pin test for applyDiscountWithReplace's failure-branch rollback.
 *
 * The FAILING state (pre-fix, ticket 2b7ea029): after `removeExistingDiscounts`
 * succeeded and the `subscription-contracts-apply-discount` PUT returned 400,
 * the function returned immediately with the contract already stripped of its
 * old CODE_DISCOUNT and no re-apply attempt. The customer lost a discount and
 * gained nothing.
 *
 * The CORRECT state (Phase 2):
 *   1. Snapshot `applied_discounts` pre-call (via removeExistingDiscounts return).
 *   2. On !res.ok && res.status !== 204:
 *      a. Re-PUT subscription-contracts-apply-discount for each removed
 *         CODE_DISCOUNT by its `.title` (the code string).
 *      b. Restore local applied_discounts to the snapshot ONLY on full re-apply
 *         success.
 *   3. Return the ORIGINAL apply error with `rolledBack: boolean` — true means
 *      the contract is back to its pre-call state; false means it is NOT (loud
 *      failure — this is the only remaining path to a stripped contract).
 *   4. A rollback that itself fails does NOT throw over the original error.
 *
 * Run:
 *   npx tsx --test src/lib/appstle-discount.rollback.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

interface StoredDiscount {
  id: string;
  title: string;
  type: string;
  value: number;
  valueType: string;
}

interface AppliedDiscountsUpdate {
  appliedDiscounts: StoredDiscount[] | null;
}

interface FetchCall {
  endpoint: "remove-discount" | "apply-discount";
  contractId: string;
  discountId: string;    // remove-discount arg (empty for apply)
  discountCode: string;  // apply-discount arg (empty for remove)
  status: number;        // returned status
}

const dbUpdates: AppliedDiscountsUpdate[] = [];
const fetchCalls: FetchCall[] = [];
const loggedAppstleCalls: Array<{ endpoint: string; status: number; success: boolean; body: unknown }> = [];
let storedRow: { workspace_id?: string; is_internal?: boolean; applied_discounts: StoredDiscount[] } | null = null;
type ApplyStatusFactory = (attemptIndex: number) => number;
let applyStatusForAttempt: ApplyStatusFactory = () => 200;
let applyAttempts = 0; // ONE for the primary apply, plus ONE per rollback re-apply

function resetWorld(rows: StoredDiscount[], statusFactory: ApplyStatusFactory): void {
  dbUpdates.length = 0;
  fetchCalls.length = 0;
  loggedAppstleCalls.length = 0;
  applyAttempts = 0;
  applyStatusForAttempt = statusFactory;
  storedRow = { is_internal: false, applied_discounts: rows };
}

// Fake Supabase — supports the exact chains the module uses.
function makeFrom(_table: string) {
  const state: { patch: Record<string, unknown> | null } = { patch: null };
  const builder = {
    select(_cols: string) {
      return builder;
    },
    eq(_col: string, _val: unknown) {
      if (state.patch) {
        dbUpdates.push({
          appliedDiscounts: (state.patch.applied_discounts as StoredDiscount[] | null) ?? null,
        });
        state.patch = null;
      }
      return builder;
    },
    single() {
      return Promise.resolve({ data: storedRow, error: null });
    },
    maybeSingle() {
      return Promise.resolve({ data: storedRow, error: null });
    },
    update(patch: Record<string, unknown>) {
      state.patch = patch;
      return builder;
    },
  };
  return builder;
}

const stubAdmin = { from: makeFrom };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };
moduleAny._cache[require.resolve("@/lib/supabase/admin")] = {
  exports: { createAdminClient: () => stubAdmin },
};
moduleAny._cache[require.resolve("@/lib/appstle-call-log")] = {
  exports: {
    logAppstleCall: async (row: { endpoint: string; status: number; success: boolean; body: unknown }) => {
      loggedAppstleCalls.push({ endpoint: row.endpoint, status: row.status, success: row.success, body: row.body });
    },
  },
};

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string) => {
  const u = String(url);
  if (u.includes("subscription-contracts-remove-discount")) {
    const contractId = /contractId=([^&]+)/.exec(u)?.[1] ?? "";
    const discountId = decodeURIComponent(/discountId=([^&]+)/.exec(u)?.[1] ?? "");
    fetchCalls.push({ endpoint: "remove-discount", contractId, discountId, discountCode: "", status: 200 });
    return new Response("{}", { status: 200 });
  }
  if (u.includes("subscription-contracts-apply-discount")) {
    const contractId = /contractId=([^&]+)/.exec(u)?.[1] ?? "";
    const discountCode = decodeURIComponent(/discountCode=([^&]+)/.exec(u)?.[1] ?? "");
    const status = applyStatusForAttempt(applyAttempts++);
    fetchCalls.push({ endpoint: "apply-discount", contractId, discountId: "", discountCode, status });
    return new Response("{}", { status });
  }
  throw new Error(`unexpected fetch: ${u}`);
}) as typeof fetch;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyDiscountWithReplace } = require("./appstle-discount") as typeof import("./appstle-discount");

test("FIX: a 400 on apply triggers a rollback re-apply of the removed CODE_DISCOUNT (Sandra's ticket 2b7ea029 shape)", async () => {
  resetWorld(
    [
      { id: "gid://autoshipping", title: "Free Shipping on Subscriptions", type: "AUTOMATIC_DISCOUNT", value: 100, valueType: "PERCENTAGE" },
      { id: "gid://loy-15",       title: "LOYALTY-15-XYZ",                type: "CODE_DISCOUNT",      value: 15,  valueType: "FIXED_AMOUNT" },
    ],
    (attempt) => attempt === 0 ? 400 : 200,
  );

  const result = await applyDiscountWithReplace("test-key", "34148253869", "PROMO-NEW");

  const applies = fetchCalls.filter(c => c.endpoint === "apply-discount");
  assert.equal(applies.length, 2, "primary apply + one rollback re-apply");
  assert.equal(applies[0]!.discountCode, "PROMO-NEW", "first apply is the caller's requested code");
  assert.equal(applies[1]!.discountCode, "LOYALTY-15-XYZ", "rollback re-applies the removed code by its title");
  assert.equal(result.success, false, "the ORIGINAL apply error is surfaced");
  assert.equal(result.status, 400, "with the original status");
  assert.equal(result.rolledBack, true, "rolledBack=true — contract is back to its pre-call state");
});

test("FIX: on successful rollback, local applied_discounts is restored to the pre-call snapshot (NOT the truncated state)", async () => {
  const snapshot = [
    { id: "gid://autoshipping", title: "Free Shipping on Subscriptions", type: "AUTOMATIC_DISCOUNT", value: 100, valueType: "PERCENTAGE" },
    { id: "gid://loy-15",       title: "LOYALTY-15-XYZ",                type: "CODE_DISCOUNT",      value: 15,  valueType: "FIXED_AMOUNT" },
  ];
  resetWorld(snapshot, (attempt) => attempt === 0 ? 400 : 200);

  await applyDiscountWithReplace("test-key", "c-1", "PROMO-NEW");

  // dbUpdates: [0] removeExistingDiscounts wrote preserved (1 row);
  //            [1] rollback restored the full snapshot (2 rows).
  assert.equal(dbUpdates.length, 2);
  const restored = dbUpdates[1]!.appliedDiscounts ?? [];
  assert.equal(restored.length, 2, "the snapshot is restored — both automatic and the code discount");
  assert.deepEqual(restored, snapshot, "restored value is byte-identical to the pre-call snapshot");
});

test("FIX: rollback that ITSELF fails returns the ORIGINAL apply error with rolledBack=false (never throws over the original)", async () => {
  resetWorld(
    [
      { id: "gid://loy-15", title: "LOYALTY-15-XYZ", type: "CODE_DISCOUNT", value: 15, valueType: "FIXED_AMOUNT" },
    ],
    // apply=400, rollback re-apply=500 (both fail)
    (attempt) => attempt === 0 ? 400 : 500,
  );

  const result = await applyDiscountWithReplace("test-key", "c-2", "PROMO-NEW");

  assert.equal(result.success, false);
  assert.equal(result.status, 400, "the ORIGINAL apply status is surfaced, not the rollback's 500");
  assert.equal(result.error, "Appstle API error: 400", "the ORIGINAL error message is preserved");
  assert.equal(result.rolledBack, false, "loud failure — rollback did not restore the contract");
  // On a failed rollback we deliberately DO NOT re-write the snapshot locally —
  // the truncated Appstle state is the truth we surface, so the loss is visible.
  const restoreWrites = dbUpdates.slice(1);
  assert.equal(restoreWrites.length, 0, "no local snapshot restore when the rollback re-apply failed");
});

test("FIX: rollback re-apply calls are logged through logAppstleCall (auditable in appstle_api_calls)", async () => {
  resetWorld(
    [
      { id: "gid://loy-15", title: "LOYALTY-15-XYZ", type: "CODE_DISCOUNT", value: 15, valueType: "FIXED_AMOUNT" },
    ],
    (attempt) => attempt === 0 ? 400 : 200,
  );

  await applyDiscountWithReplace("test-key", "c-3", "PROMO-NEW");

  const applyLogs = loggedAppstleCalls.filter(l => l.endpoint === "apply-discount");
  assert.equal(applyLogs.length, 2, "both the primary apply AND the rollback re-apply are logged");
  const rollbackLog = applyLogs.find(l => (l.body as { rollback?: boolean }).rollback === true);
  assert.ok(rollbackLog, "rollback log carries a rollback:true marker so appstle_api_calls can partition them");
  assert.equal(rollbackLog.success, true, "the successful rollback re-apply is logged as success:true");
});

test("BASELINE: a successful apply is unchanged — no rollback, rolledBack undefined, applied_discounts written from the response", async () => {
  resetWorld(
    [{ id: "gid://loy-15", title: "LOYALTY-15-XYZ", type: "CODE_DISCOUNT", value: 15, valueType: "FIXED_AMOUNT" }],
    () => 200,
  );

  const result = await applyDiscountWithReplace("test-key", "c-4", "PROMO-NEW");

  const applies = fetchCalls.filter(c => c.endpoint === "apply-discount");
  assert.equal(applies.length, 1, "only the primary apply — no rollback on success");
  assert.equal(result.success, true);
  assert.equal(result.rolledBack, undefined, "rolledBack is absent on the success path — it's a failure-branch signal");
});

test("BASELINE: an apply failure with NO code discounts to restore returns rolledBack=true (nothing to roll back is a trivial success)", async () => {
  resetWorld(
    [{ id: "gid://autoshipping", title: "Free Shipping on Subscriptions", type: "AUTOMATIC_DISCOUNT", value: 100, valueType: "PERCENTAGE" }],
    () => 400,
  );

  const result = await applyDiscountWithReplace("test-key", "c-5", "PROMO-NEW");

  const applies = fetchCalls.filter(c => c.endpoint === "apply-discount");
  assert.equal(applies.length, 1, "no rollback re-apply — there was nothing to restore");
  assert.equal(result.success, false);
  assert.equal(result.status, 400);
  assert.equal(result.rolledBack, true, "empty rollback set = trivially rolled back (no loss occurred)");
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
