/**
 * Phase 1 of internal-renewal-shipping-address-carries-the-customer-name.
 *
 * Pins the invariant this phase adds inside `resolveInternalRenewalShipping`
 * (src/lib/inngest/internal-subscription-renewals.ts): a renewal address that
 * lacks a recipient name gets the customer's first/last injected, and an
 * address that already names a recipient is left alone. The failing state
 * is Amplifier 400ing with "Shipping Name is required" and the paid order
 * silently sitting unshipped forever — 2 real cases on 2026-08-10
 * (SHOPCX170 Shannon Russell + SHOPCX181).
 *
 * Pure function, no I/O — a direct import.
 *
 * Run:
 *   npx tsx --test src/lib/inngest/internal-subscription-renewals.shipping-name.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveInternalRenewalShipping } from "./internal-subscription-renewals";

test("Phase 1: a nameless stored address plus a named customer yields an address carrying the customer's name", () => {
  const res = resolveInternalRenewalShipping(
    { shipping_address: { address1: "1 Main St", city: "Austin", province: "TX", country: "US", zip: "78701" } },
    null,
    { first_name: "Shannon", last_name: "Russell", default_address: null },
  );
  assert.equal(res.needsHuman, false);
  if (res.needsHuman) return;
  assert.equal((res.shipping as Record<string, unknown>).firstName, "Shannon");
  assert.equal((res.shipping as Record<string, unknown>).lastName, "Russell");
  // Original fields preserved.
  assert.equal((res.shipping as Record<string, unknown>).address1, "1 Main St");
});

test("Phase 1: an address that already names a different recipient is left alone (a customer may ship to someone else)", () => {
  const res = resolveInternalRenewalShipping(
    {
      shipping_address: {
        firstName: "Aunt",
        lastName: "Cara",
        address1: "9 Elm",
        city: "Denver",
        province: "CO",
        country: "US",
        zip: "80202",
      },
    },
    null,
    { first_name: "Shannon", last_name: "Russell", default_address: null },
  );
  assert.equal(res.needsHuman, false);
  if (res.needsHuman) return;
  assert.equal((res.shipping as Record<string, unknown>).firstName, "Aunt");
  assert.equal((res.shipping as Record<string, unknown>).lastName, "Cara");
});

test("Phase 1: a snake_case first_name on the stored address counts as a name (no overwrite)", () => {
  const res = resolveInternalRenewalShipping(
    { shipping_address: { first_name: "Aunt", last_name: "Cara", address1: "9 Elm" } },
    null,
    { first_name: "Shannon", last_name: "Russell", default_address: null },
  );
  assert.equal(res.needsHuman, false);
  if (res.needsHuman) return;
  // Original snake_case name is preserved verbatim — we do NOT rewrite to camelCase.
  assert.equal((res.shipping as Record<string, unknown>).first_name, "Aunt");
  assert.equal((res.shipping as Record<string, unknown>).last_name, "Cara");
  assert.equal((res.shipping as Record<string, unknown>).firstName, undefined);
});

test("Phase 1: a combined `name` field on the stored address counts as a name (no overwrite)", () => {
  const res = resolveInternalRenewalShipping(
    { shipping_address: { name: "Aunt Cara", address1: "9 Elm" } },
    null,
    { first_name: "Shannon", last_name: "Russell", default_address: null },
  );
  assert.equal(res.needsHuman, false);
  if (res.needsHuman) return;
  assert.equal((res.shipping as Record<string, unknown>).name, "Aunt Cara");
  assert.equal((res.shipping as Record<string, unknown>).firstName, undefined);
});

test("Phase 1: the billing address returned alongside gets the same name treatment", () => {
  const res = resolveInternalRenewalShipping(
    { shipping_address: { address1: "1 Main St" } },
    { shipping_address: null, billing_address: { address1: "2 Bank St" } },
    { first_name: "Shannon", last_name: "Russell", default_address: null },
  );
  assert.equal(res.needsHuman, false);
  if (res.needsHuman) return;
  assert.equal((res.billing as Record<string, unknown>).firstName, "Shannon");
  assert.equal((res.billing as Record<string, unknown>).lastName, "Russell");
});

test("Phase 1: billing falls back to the resolved shipping (with name) when the last order has none of its own", () => {
  const res = resolveInternalRenewalShipping(
    { shipping_address: { address1: "1 Main St" } },
    null,
    { first_name: "Shannon", last_name: "Russell", default_address: null },
  );
  assert.equal(res.needsHuman, false);
  if (res.needsHuman) return;
  assert.equal((res.billing as Record<string, unknown>).firstName, "Shannon");
  assert.equal((res.billing as Record<string, unknown>).lastName, "Russell");
});

test("Phase 1: no name on the address AND no name on the customer → needsHuman (never dispatch a doomed request)", () => {
  const res = resolveInternalRenewalShipping(
    { shipping_address: { address1: "1 Main St", city: "Austin" } },
    null,
    { first_name: null, last_name: null, default_address: null },
  );
  assert.equal(res.needsHuman, true);
  if (!res.needsHuman) return;
  assert.equal(res.reason, "no_recipient_name");
});

test("Phase 1: whitespace-only customer name counts as no name (must not send \"  \" as the recipient)", () => {
  const res = resolveInternalRenewalShipping(
    { shipping_address: { address1: "1 Main St" } },
    null,
    { first_name: "   ", last_name: "\t", default_address: null },
  );
  assert.equal(res.needsHuman, true);
});

test("Phase 1: sub without its own address falls back to the last order's address and still gets the name injected", () => {
  const res = resolveInternalRenewalShipping(
    { shipping_address: null },
    { shipping_address: { address1: "9 Elm St" }, billing_address: null },
    { first_name: "Shannon", last_name: "Russell", default_address: null },
  );
  assert.equal(res.needsHuman, false);
  if (res.needsHuman) return;
  assert.equal((res.shipping as Record<string, unknown>).firstName, "Shannon");
  assert.equal((res.shipping as Record<string, unknown>).address1, "9 Elm St");
});

test("Phase 1: sub without an address, no last order — falls back to customer.default_address and injects the name", () => {
  const res = resolveInternalRenewalShipping(
    { shipping_address: null },
    null,
    {
      first_name: "Shannon",
      last_name: "Russell",
      default_address: { address1: "1 Default Ln", city: "Austin" },
    },
  );
  assert.equal(res.needsHuman, false);
  if (res.needsHuman) return;
  assert.equal((res.shipping as Record<string, unknown>).firstName, "Shannon");
  assert.equal((res.shipping as Record<string, unknown>).address1, "1 Default Ln");
});

test("Phase 1: nothing at all — null address, null customer → not needsHuman (nothing to attempt), null pass-through", () => {
  const res = resolveInternalRenewalShipping(null, null, null);
  assert.equal(res.needsHuman, false);
  if (res.needsHuman) return;
  assert.equal(res.shipping, null);
  assert.equal(res.billing, null);
});
