/**
 * Unit tests for commerce/subscription.subscriptionUpdateShippingAddress
 * (Phase 1 of docs/brain/specs/internal-sub-write-path-gaps.md).
 *
 * Pins the two-branch contract:
 *  - Internal sub: writes `subscriptions.shipping_address` (the SoT the
 *    daily renewal cron reads) and surfaces a DB error instead of the
 *    prior silent `{ success: true }` no-op.
 *  - Appstle sub: still issues the vendor PUT carrying the address fields
 *    (regression guard against a future refactor collapsing it to a
 *    DB-only write and silently dropping every vendor address change),
 *    AND mirrors the address onto our column ONLY after the vendor
 *    accepts.
 *
 * The test injects fake deps into `subscriptionUpdateShippingAddress`
 * (its `deps` parameter) — no Supabase, no fetch, no vendor.
 *
 * Run:
 *   npm run test:commerce-subscription-update-shipping-address
 *   (= tsx --test src/lib/commerce/subscription.updateShippingAddress.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  subscriptionUpdateShippingAddress,
  type UpdateShippingAddressDeps,
} from "./subscription";
import { buildShippingAddressRow, type ShippingAddressInput } from "@/lib/internal-subscription";

const WORKSPACE = "11111111-1111-1111-1111-111111111111";
const INTERNAL_CONTRACT = "internal-abc123";
const APPSTLE_CONTRACT = "9876543210";

function baseAddress(overrides: Partial<ShippingAddressInput> = {}): ShippingAddressInput {
  return {
    address1: "123 Main St",
    address2: "Apt 4",
    city: "Austin",
    zip: "78701",
    country: "US",
    province: "TX",
    firstName: "Ada",
    lastName: "Lovelace",
    phone: "+15125551212",
    ...overrides,
  };
}

interface Recorder {
  isInternalCalls: Array<{ workspaceId: string; contractId: string }>;
  vendorFetchCalls: Array<{ url: string; init: RequestInit }>;
  writeLocalCalls: Array<{ workspaceId: string; contractId: string; address: ShippingAddressInput }>;
  getVendorApiKeyCalls: Array<string>;
}

function makeDeps(overrides: Partial<UpdateShippingAddressDeps> & { internal: boolean }): {
  deps: UpdateShippingAddressDeps;
  rec: Recorder;
} {
  const rec: Recorder = {
    isInternalCalls: [],
    vendorFetchCalls: [],
    writeLocalCalls: [],
    getVendorApiKeyCalls: [],
  };
  const deps: UpdateShippingAddressDeps = {
    async isInternal(workspaceId, contractId) {
      rec.isInternalCalls.push({ workspaceId, contractId });
      return overrides.internal;
    },
    async getVendorApiKey(workspaceId) {
      rec.getVendorApiKeyCalls.push(workspaceId);
      return "test-api-key";
    },
    async vendorFetch(url, init) {
      rec.vendorFetchCalls.push({ url, init });
      return new Response(null, { status: 200 });
    },
    async writeLocal(workspaceId, contractId, address) {
      rec.writeLocalCalls.push({ workspaceId, contractId, address });
      return { success: true };
    },
    ...overrides,
  };
  return { deps, rec };
}

// ── Pure-shape helper ────────────────────────────────────────────────

test("buildShippingAddressRow: matches the on-row shape the portal/checkout/renewal cron use", () => {
  const row = buildShippingAddressRow(baseAddress());
  assert.deepEqual(row, {
    first_name: "Ada",
    last_name: "Lovelace",
    phone: "+15125551212",
    address1: "123 Main St",
    address2: "Apt 4",
    city: "Austin",
    province_code: "TX",
    zip: "78701",
    country_code: "US",
  });
});

test("buildShippingAddressRow: empty phone → null (matches portal writer)", () => {
  const row = buildShippingAddressRow(baseAddress({ phone: "" }));
  assert.equal(row.phone, null);
});

test("buildShippingAddressRow: empty address2 → null (matches portal writer)", () => {
  const row = buildShippingAddressRow(baseAddress({ address2: "" }));
  assert.equal(row.address2, null);
});

// ── Internal branch ─────────────────────────────────────────────────

test("internal branch: writes subscriptions.shipping_address via writeLocal and DOES NOT hit vendor", async () => {
  const { deps, rec } = makeDeps({ internal: true });
  const result = await subscriptionUpdateShippingAddress(WORKSPACE, INTERNAL_CONTRACT, baseAddress(), deps);
  assert.equal(result.success, true);
  assert.equal(rec.writeLocalCalls.length, 1);
  assert.deepEqual(rec.writeLocalCalls[0], {
    workspaceId: WORKSPACE,
    contractId: INTERNAL_CONTRACT,
    address: baseAddress(),
  });
  assert.equal(rec.vendorFetchCalls.length, 0, "internal branch must not hit the vendor");
  assert.equal(rec.getVendorApiKeyCalls.length, 0, "internal branch must not fetch the vendor key");
});

test("internal branch: DB failure surfaces as { success: false, error } (not a silent success — the defect this closes)", async () => {
  const { deps, rec } = makeDeps({
    internal: true,
    writeLocal: async () => ({ success: false, error: "db exploded" }),
  });
  const result = await subscriptionUpdateShippingAddress(WORKSPACE, INTERNAL_CONTRACT, baseAddress(), deps);
  assert.equal(result.success, false);
  assert.equal(result.error, "db exploded");
  assert.equal(rec.vendorFetchCalls.length, 0);
});

// ── Appstle branch — vendor PUT ────────────────────────────────────

test("Appstle branch: issues the vendor PUT carrying the address fields (regression guard against local-only refactor)", async () => {
  const { deps, rec } = makeDeps({ internal: false });
  const result = await subscriptionUpdateShippingAddress(WORKSPACE, APPSTLE_CONTRACT, baseAddress(), deps);
  assert.equal(result.success, true);
  assert.equal(rec.vendorFetchCalls.length, 1, "Appstle branch MUST reach the vendor — never collapse to a local write");
  const call = rec.vendorFetchCalls[0];
  assert.ok(
    call.url.includes("subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-shipping-address"),
    "vendor URL must be Appstle's update-shipping-address endpoint",
  );
  assert.ok(call.url.includes(`contractId=${APPSTLE_CONTRACT}`), "contractId must be in the URL");
  assert.equal(call.init.method, "PUT");
  const body = JSON.parse(String(call.init.body));
  assert.equal(body.address1, "123 Main St");
  assert.equal(body.address2, "Apt 4");
  assert.equal(body.city, "Austin");
  assert.equal(body.zip, "78701");
  assert.equal(body.country, "US");
  assert.equal(body.countryCode, "US"); // vendor GraphQL validator wants the code duplicate
  assert.equal(body.province, "TX");
  assert.equal(body.provinceCode, "TX");
  assert.equal(body.firstName, "Ada");
  assert.equal(body.lastName, "Lovelace");
  assert.equal(body.phone, "+15125551212");
});

test("Appstle branch: no vendor key → { success: false, 'Subscription vendor not configured' } (never local-only fallback)", async () => {
  const { deps, rec } = makeDeps({
    internal: false,
    getVendorApiKey: async () => null,
  });
  const result = await subscriptionUpdateShippingAddress(WORKSPACE, APPSTLE_CONTRACT, baseAddress(), deps);
  assert.equal(result.success, false);
  assert.equal(result.error, "Subscription vendor not configured");
  assert.equal(rec.vendorFetchCalls.length, 0);
  assert.equal(rec.writeLocalCalls.length, 0, "no vendor key must not silently downgrade to a local-only write");
});

test("Appstle branch: vendor non-ok → { success: false, 'Vendor N' } and NO local mirror write (never record an address the vendor rejected)", async () => {
  const { deps, rec } = makeDeps({
    internal: false,
    vendorFetch: async () => new Response(null, { status: 422 }),
  });
  const result = await subscriptionUpdateShippingAddress(WORKSPACE, APPSTLE_CONTRACT, baseAddress(), deps);
  assert.equal(result.success, false);
  assert.equal(result.error, "Vendor 422");
  assert.equal(rec.writeLocalCalls.length, 0, "must NOT mirror onto our column when vendor rejected");
});

// ── Appstle branch — local mirror after vendor accepts ─────────────

test("Appstle branch: after a successful vendor PUT, ALSO writes subscriptions.shipping_address via writeLocal", async () => {
  const { deps, rec } = makeDeps({ internal: false });
  const result = await subscriptionUpdateShippingAddress(WORKSPACE, APPSTLE_CONTRACT, baseAddress(), deps);
  assert.equal(result.success, true);
  assert.equal(rec.writeLocalCalls.length, 1, "Appstle branch must mirror to our row after vendor accepts");
  assert.deepEqual(rec.writeLocalCalls[0], {
    workspaceId: WORKSPACE,
    contractId: APPSTLE_CONTRACT,
    address: baseAddress(),
  });
});

test("Appstle branch: vendor accepted → local mirror runs AFTER the vendor call (order matters — never record before vendor)", async () => {
  const order: string[] = [];
  const { deps } = makeDeps({
    internal: false,
    vendorFetch: async () => {
      order.push("vendor");
      return new Response(null, { status: 200 });
    },
    writeLocal: async () => {
      order.push("local");
      return { success: true };
    },
  });
  await subscriptionUpdateShippingAddress(WORKSPACE, APPSTLE_CONTRACT, baseAddress(), deps);
  assert.deepEqual(order, ["vendor", "local"]);
});

test("Appstle branch: local mirror failure AFTER successful vendor PUT does NOT flip success — customer's address DID change where it ships from", async () => {
  const originalErr = console.error;
  const logged: string[] = [];
  console.error = (msg?: unknown) => { logged.push(String(msg)); };
  try {
    const { deps } = makeDeps({
      internal: false,
      writeLocal: async () => ({ success: false, error: "db timeout" }),
    });
    const result = await subscriptionUpdateShippingAddress(WORKSPACE, APPSTLE_CONTRACT, baseAddress(), deps);
    assert.equal(result.success, true, "vendor accepted → result stays success even if local mirror fails");
    assert.ok(
      logged.some((l) => l.includes("Appstle vendor PUT succeeded but local row write failed") && l.includes(APPSTLE_CONTRACT)),
      "the swallowed local-write failure must be logged loudly (compensating-write rail shape)",
    );
  } finally {
    console.error = originalErr;
  }
});
