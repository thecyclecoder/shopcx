/**
 * Phase-1 pin test for the Appstle discount replace bug that stripped
 * Sandra Lutz's 'Free Shipping on Subscriptions' AUTOMATIC_DISCOUNT from
 * contract 34148253869 on 2026-07-24 (ticket 2b7ea029).
 *
 * The FAILING state (pre-fix): `removeExistingDiscounts` iterated every
 * row of `subscriptions.applied_discounts` and PUT
 * subscription-contracts-remove-discount for each — regardless of
 * `type` — then overwrote the local column with `[]`.
 *
 * The CORRECT state (Phase 1): only rows whose `type === 'CODE_DISCOUNT'`
 * are removed. AUTOMATIC_DISCOUNT, MANUAL, and any unknown/missing-type
 * row is PRESERVED — never PUT to Appstle, never dropped from the local
 * write-back.
 *
 * Run:
 *   npx tsx --test src/lib/appstle-discount.code-only.test.ts
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

interface RemoveCall {
  contractId: string;
  discountId: string;
}

interface AppliedDiscountsUpdate {
  appliedDiscounts: StoredDiscount[] | null;
}

const removeCalls: RemoveCall[] = [];
const dbUpdates: AppliedDiscountsUpdate[] = [];
let storedRow: { applied_discounts: StoredDiscount[] } | null = null;
let lastRemoveStatus = 200;

function resetWorld(rows: StoredDiscount[], status = 200): void {
  removeCalls.length = 0;
  dbUpdates.length = 0;
  storedRow = { applied_discounts: rows };
  lastRemoveStatus = status;
}

// Minimal stub for the two Supabase access shapes removeExistingDiscounts uses:
//   .from("subscriptions").select("applied_discounts").eq(...).single()
//   .from("subscriptions").update(patch).eq(...)
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
  exports: { logAppstleCall: async () => undefined },
};

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string) => {
  const u = String(url);
  if (u.includes("subscription-contracts-remove-discount")) {
    const contractId = /contractId=([^&]+)/.exec(u)?.[1] ?? "";
    const discountId = decodeURIComponent(/discountId=([^&]+)/.exec(u)?.[1] ?? "");
    removeCalls.push({ contractId, discountId });
    return new Response("{}", { status: lastRemoveStatus });
  }
  throw new Error(`unexpected fetch: ${u}`);
}) as typeof fetch;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { removeExistingDiscounts } = require("./appstle-discount") as typeof import("./appstle-discount");

test("FIX: removeExistingDiscounts skips AUTOMATIC_DISCOUNT rows — Sandra's free-shipping is never PUT to Appstle", async () => {
  resetWorld([
    { id: "gid://autoshipping", title: "Free Shipping on Subscriptions", type: "AUTOMATIC_DISCOUNT", value: 100, valueType: "PERCENTAGE" },
    { id: "gid://loy-15",       title: "LOYALTY-15-XYZ",                type: "CODE_DISCOUNT",      value: 15,  valueType: "FIXED_AMOUNT" },
  ]);

  const out = await removeExistingDiscounts("test-key", "34148253869");

  assert.equal(removeCalls.length, 1, "only ONE remove-discount PUT — for the CODE_DISCOUNT");
  assert.equal(removeCalls[0]!.discountId, "gid://loy-15", "the AUTOMATIC_DISCOUNT is never sent to Appstle");
  assert.deepEqual(out.removed, ["gid://loy-15"]);
  assert.equal(out.preserved.length, 1, "preserved returns the surviving rows");
  assert.equal(out.preserved[0]!.type, "AUTOMATIC_DISCOUNT");
  assert.equal(out.preserved[0]!.title, "Free Shipping on Subscriptions");
});

test("FIX: the local applied_discounts write-back preserves the AUTOMATIC_DISCOUNT rows — no more wholesale []", async () => {
  resetWorld([
    { id: "gid://autoshipping", title: "Free Shipping on Subscriptions", type: "AUTOMATIC_DISCOUNT", value: 100, valueType: "PERCENTAGE" },
    { id: "gid://loy-15",       title: "LOYALTY-15-XYZ",                type: "CODE_DISCOUNT",      value: 15,  valueType: "FIXED_AMOUNT" },
  ]);

  await removeExistingDiscounts("test-key", "34148253869");

  assert.equal(dbUpdates.length, 1, "one DB write happened (a CODE_DISCOUNT was removed)");
  const written = dbUpdates[0]!.appliedDiscounts ?? [];
  assert.equal(written.length, 1, "the write-back keeps the surviving row — NOT [] as before");
  assert.equal(written[0]!.type, "AUTOMATIC_DISCOUNT", "the AUTOMATIC_DISCOUNT survives locally too");
});

test("FIX: MANUAL rows (cancel-flow retention discounts) are also preserved", async () => {
  resetWorld([
    { id: "gid://cancel-27864596653", title: "cancel27864596653", type: "MANUAL",        value: 10, valueType: "PERCENTAGE" },
    { id: "gid://loy-15",             title: "LOYALTY-15-XYZ",   type: "CODE_DISCOUNT", value: 15, valueType: "FIXED_AMOUNT" },
  ]);

  const out = await removeExistingDiscounts("test-key", "c-1");

  assert.equal(removeCalls.length, 1);
  assert.equal(removeCalls[0]!.discountId, "gid://loy-15");
  assert.equal(out.preserved.length, 1);
  assert.equal(out.preserved[0]!.type, "MANUAL");
});

test("FIX: unknown-or-missing type is treated as PRESERVE (never removable)", async () => {
  resetWorld([
    { id: "gid://weird", title: "unknown-thing", type: "SOMETHING_NEW",           value: 5, valueType: "PERCENTAGE" },
    { id: "gid://none",  title: "missing-type",  type: undefined as unknown as string, value: 5, valueType: "PERCENTAGE" },
    { id: "gid://loy-5", title: "LOYALTY-5-A",   type: "CODE_DISCOUNT",           value: 5, valueType: "FIXED_AMOUNT" },
  ]);

  const out = await removeExistingDiscounts("test-key", "c-2");

  assert.equal(removeCalls.length, 1, "only the CODE_DISCOUNT is PUT — unknown types are never removable");
  assert.equal(out.preserved.length, 2);
});

test("FIX: an all-AUTOMATIC applied_discounts is a NO-OP — no PUT to Appstle, no local write-back to []", async () => {
  resetWorld([
    { id: "gid://autoshipping", title: "Free Shipping on Subscriptions", type: "AUTOMATIC_DISCOUNT", value: 100, valueType: "PERCENTAGE" },
    { id: "gid://buy2",         title: "Buy 2 Discount",                 type: "AUTOMATIC_DISCOUNT", value: 5,   valueType: "PERCENTAGE" },
  ]);

  const out = await removeExistingDiscounts("test-key", "c-3");

  assert.equal(removeCalls.length, 0, "no code discounts → no Appstle mutation at all");
  assert.equal(dbUpdates.length, 0, "no code discounts → no local write — the previous bug wrote [] here");
  assert.equal(out.removed.length, 0);
  assert.equal(out.preserved.length, 2, "both AUTOMATIC rows returned as preserved");
});

// ── cleanup ─────────────────────────────────────────────────────────
test.after(() => {
  globalThis.fetch = originalFetch;
});
