/**
 * Unit tests for the suppressed-variant guard — the pure predicate that
 * [[./mutation-guard]] exports and that both [[./handlers/bootstrap]] (catalog
 * filter) and [[./handlers/replace-variants]] (server-side rejection) call.
 *
 * Focus: the concrete failing state named in
 * spec-suppress-strawberry-lemonade-superfood-tabs.md — a portal
 * replaceVariants request targeting Strawberry Lemonade (Shopify variant
 * 42614433480877 / SKU SC-TABS-SL-2) MUST be rejected server-side once SL is
 * on the workspace's suppressed set. Existing subs on SL are NOT touched by
 * this predicate — it only screens the NEW-selection payload.
 *
 *   npx tsx --test src/lib/portal/suppressed-variants.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { findSuppressedNewVariants } from "./mutation-guard";

const SL_VARIANT_ID = "42614433480877"; // Strawberry Lemonade — SC-TABS-SL-2

test("Strawberry Lemonade is rejected when on the suppressed set", () => {
  const suppressed = new Set([SL_VARIANT_ID]);
  const blocked = findSuppressedNewVariants([SL_VARIANT_ID], suppressed);
  assert.deepEqual(blocked, [SL_VARIANT_ID]);
});

test("Peach Mango (the surviving flavor) passes through", () => {
  const suppressed = new Set([SL_VARIANT_ID]);
  const blocked = findSuppressedNewVariants(["42614433513645"], suppressed);
  assert.deepEqual(blocked, []);
});

test("empty suppressed set → nothing is ever blocked (fast path)", () => {
  assert.deepEqual(findSuppressedNewVariants([SL_VARIANT_ID, "42614433513645"], new Set()), []);
});

test("GID-form variant refs are normalised before the check (crafted request shape)", () => {
  const suppressed = new Set([SL_VARIANT_ID]);
  const blocked = findSuppressedNewVariants(
    [`gid://shopify/ProductVariant/${SL_VARIANT_ID}`],
    suppressed,
  );
  assert.deepEqual(blocked, [SL_VARIANT_ID]);
});

test("mixed batch → only the suppressed IDs come back", () => {
  const suppressed = new Set([SL_VARIANT_ID]);
  const blocked = findSuppressedNewVariants(
    ["42614433513645", SL_VARIANT_ID, "999"],
    suppressed,
  );
  assert.deepEqual(blocked, [SL_VARIANT_ID]);
});
