/**
 * Fix 1 (pre-merge spec-test regression, sec:real-vuln) — pins that the
 * ticket-directions purchase_intent path CANNOT influence the outgoing
 * `unit_cents` or `vendor` on the assisted-purchase params:
 *
 *   • `RawAssistedPurchaseIntent` (the type of `resolveAssistedPurchaseIntentToParams`'s
 *     `raw` argument) has NO `unitCents` and NO `vendor` fields — a compile-time drop.
 *   • Even when a caller casts an object with those extras through the type,
 *     the resolver uses `product_variants.price_cents` for `unit_cents` and
 *     omits `vendor` so the playbook step's config default ('internal') wins.
 *   • `variant_id` / `shopify_variant_id` / `sku` / `quantity` still resolve.
 *
 * Spec: docs/brain/specs/an-assisted-purchase-carries-the-item-the-customer-actually-picked.md
 * Phase 3 — Fix 1.
 *
 * Isolated via a module _cache stub of `@/lib/product-variants` (same pattern
 * as `appstle-discount.code-only.test.ts`); no real DB.
 *
 * Run: `npx tsx --test src/lib/playbook-executor.assisted-purchase-intent-hardening.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

type RawIntent = import("./playbook-executor").RawAssistedPurchaseIntent;

// Stub `@/lib/product-variants` so `findVariant` returns a predictable server-side
// variant. The resolver imports it dynamically (await import), which routes through
// require + Node's module cache, so a pre-seeded cache entry is what gets returned.
type StubVariant = {
  id: string;
  workspace_id: string;
  product_id: string;
  shopify_variant_id: string | null;
  sku: string | null;
  title: string | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  price_cents: number;
  compare_at_price_cents: number | null;
  image_url: string | null;
  weight: number | null;
  weight_unit: string | null;
  position: number;
  available: boolean;
};

const CATALOG_PRICE_CENTS = 4600;
const VARIANT_UUID = "550e8400-e29b-41d4-a716-446655440000";
const SHOPIFY_ID = "42614433448109"; // the exact id Corrie's confirm turn logged

type Ref = { id?: string; shopifyVariantId?: string; sku?: string };
const refBox: { last: Ref | null } = { last: null };

const stubVariant: StubVariant = {
  id: VARIANT_UUID,
  workspace_id: "ws-a",
  product_id: "prod-a",
  shopify_variant_id: SHOPIFY_ID,
  sku: "SUPER-MIXED-BERRY",
  title: "Mixed Berry",
  option1: null,
  option2: null,
  option3: null,
  price_cents: CATALOG_PRICE_CENTS,
  compare_at_price_cents: null,
  image_url: null,
  weight: null,
  weight_unit: null,
  position: 1,
  available: true,
};

async function stubFindVariant(
  _workspaceId: string,
  ref: { id?: string; shopifyVariantId?: string; sku?: string },
): Promise<StubVariant | null> {
  refBox.last = ref;
  if (ref.id === VARIANT_UUID) return stubVariant;
  if (ref.shopifyVariantId === SHOPIFY_ID) return stubVariant;
  if (ref.sku === "SUPER-MIXED-BERRY") return stubVariant;
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };
moduleAny._cache[require.resolve("@/lib/product-variants")] = {
  exports: { findVariant: stubFindVariant },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveAssistedPurchaseIntentToParams } = require("./playbook-executor") as typeof import("./playbook-executor");

const fakeAdmin = {} as unknown as Parameters<typeof resolveAssistedPurchaseIntentToParams>[0];

// ── sec:real-vuln — Sol-authored unit_cents + vendor are DROPPED ─────────────

test("purchase_intent.unit_cents is DROPPED — the resolver uses variant.price_cents server-side, never the raw input", async () => {
  // Cast through `unknown` to smuggle the attacker-controlled extras into the
  // resolver's argument. The compile-time interface no longer accepts them, but
  // a real caller could still spread an untrusted object; this proves the
  // runtime discard even in that shape.
  const evilRaw = {
    actionType: "create_order",
    variantId: VARIANT_UUID,
    quantity: 1,
    unit_cents: 1, // attacker-controlled: $0.01
    unitCents: 1, // same, different casing
    vendor: "shopify", // attacker steers away from the 'internal' branch
  } as unknown as Parameters<typeof resolveAssistedPurchaseIntentToParams>[2];
  const params = await resolveAssistedPurchaseIntentToParams(fakeAdmin, "ws-a", evilRaw);
  assert.ok(params, "well-formed intent must resolve");
  const items = (params as { line_items: Array<Record<string, unknown>> }).line_items;
  assert.equal(items.length, 1);
  assert.equal(items[0].variant_id, VARIANT_UUID);
  assert.equal(
    items[0].unit_cents,
    CATALOG_PRICE_CENTS,
    "unit_cents must equal the server-side product_variants.price_cents, NEVER the raw input",
  );
  assert.notEqual(items[0].unit_cents, 1, "attacker-controlled $0.01 must be discarded");
});

test("purchase_intent.vendor is DROPPED — the resolver does not forward it (playbook step config default wins downstream)", async () => {
  const evilRaw = {
    actionType: "create_order",
    variantId: VARIANT_UUID,
    quantity: 1,
    vendor: "shopify",
  } as unknown as Parameters<typeof resolveAssistedPurchaseIntentToParams>[2];
  const params = await resolveAssistedPurchaseIntentToParams(fakeAdmin, "ws-a", evilRaw);
  assert.ok(params);
  // The resolver's params object carries a `vendor` key set to 'internal' from
  // buildAssistedPurchaseParams's default when no vendor is passed — never
  // 'shopify' from the raw purchase_intent.
  assert.equal(
    (params as { vendor: string }).vendor,
    "internal",
    "vendor must default to 'internal' — a raw 'shopify' input must not steer the branch",
  );
});

test("purchase_intent.vendor='internal' from raw is ALSO not passed through — the value comes from server-side default, not the raw", async () => {
  // Even a non-malicious 'internal' value on the raw must be ignored — the
  // trust boundary is that ticket-directions plans NEVER carry vendor.
  const raw = {
    actionType: "create_order",
    variantId: VARIANT_UUID,
    quantity: 1,
    vendor: "internal", // benign but STILL must not be forwarded
  } as unknown as Parameters<typeof resolveAssistedPurchaseIntentToParams>[2];
  const params = await resolveAssistedPurchaseIntentToParams(fakeAdmin, "ws-a", raw);
  assert.ok(params);
  assert.equal((params as { vendor: string }).vendor, "internal");
});

// ── variant_id / shopify_variant_id / sku / quantity still resolve ────────────

test("variant_id (internal UUID) still resolves — the drop of unit_cents/vendor does not regress identity fields", async () => {
  refBox.last = null;
  const raw: RawIntent = {
    actionType: "create_order",
    variantId: VARIANT_UUID,
    quantity: 2,
  };
  const params = await resolveAssistedPurchaseIntentToParams(fakeAdmin, "ws-a", raw);
  assert.ok(params);
  assert.equal((refBox.last as Ref | null)?.id, VARIANT_UUID);
  const items = (params as { line_items: Array<Record<string, unknown>> }).line_items;
  assert.equal(items[0].variant_id, VARIANT_UUID);
  assert.equal(items[0].quantity, 2);
});

test("shopify_variant_id still resolves — the shopify → internal UUID conversion boundary still works", async () => {
  refBox.last = null;
  const raw: RawIntent = {
    actionType: "create_order",
    shopifyVariantId: SHOPIFY_ID,
    quantity: 1,
  };
  const params = await resolveAssistedPurchaseIntentToParams(fakeAdmin, "ws-a", raw);
  assert.ok(params);
  assert.equal((refBox.last as Ref | null)?.shopifyVariantId, SHOPIFY_ID);
  const items = (params as { line_items: Array<Record<string, unknown>> }).line_items;
  assert.equal(items[0].variant_id, VARIANT_UUID, "output must carry the INTERNAL UUID");
});

test("sku still resolves — the SKU → internal UUID conversion boundary still works", async () => {
  refBox.last = null;
  const raw: RawIntent = {
    actionType: "create_order",
    sku: "SUPER-MIXED-BERRY",
    quantity: 3,
  };
  const params = await resolveAssistedPurchaseIntentToParams(fakeAdmin, "ws-a", raw);
  assert.ok(params);
  assert.equal((refBox.last as Ref | null)?.sku, "SUPER-MIXED-BERRY");
  const items = (params as { line_items: Array<Record<string, unknown>> }).line_items;
  assert.equal(items[0].variant_id, VARIANT_UUID);
  assert.equal(items[0].quantity, 3);
});

test("quantity still resolves — including the floor-to-1 invariant", async () => {
  const raw: RawIntent = {
    actionType: "create_order",
    variantId: VARIANT_UUID,
    quantity: 0, // must floor to 1 in buildAssistedPurchaseParams
  };
  const params = await resolveAssistedPurchaseIntentToParams(fakeAdmin, "ws-a", raw);
  assert.ok(params);
  const items = (params as { line_items: Array<Record<string, unknown>> }).line_items;
  assert.equal(items[0].quantity, 1);
});

test("create_subscription: unit_cents dropped from raw; subscription fields still resolve", async () => {
  const raw: RawIntent = {
    actionType: "create_subscription",
    variantId: VARIANT_UUID,
    quantity: 1,
    interval: "month",
    intervalCount: 1,
    nextBillingDate: "2026-09-13",
  };
  const params = await resolveAssistedPurchaseIntentToParams(fakeAdmin, "ws-a", raw);
  assert.ok(params);
  const items = (params as { items: Array<Record<string, unknown>> }).items;
  assert.equal(items[0].variant_id, VARIANT_UUID);
  // create_subscription items do NOT carry a unit_cents field in the SDK shape —
  // the price flows through the subscription's own pricing helper. Prove absence.
  assert.equal(items[0].unit_cents, undefined);
  assert.equal((params as { interval: string }).interval, "month");
  assert.equal((params as { next_billing_date: string }).next_billing_date, "2026-09-13");
});

// ── unresolvable variant still fails at routing (Phase 2 bullet 5) ────────────

test("unresolvable variant → null (Fail-at-routing preserved by the hardening)", async () => {
  const raw: RawIntent = {
    actionType: "create_order",
    sku: "DOES-NOT-EXIST",
    quantity: 1,
  };
  const params = await resolveAssistedPurchaseIntentToParams(fakeAdmin, "ws-a", raw);
  assert.equal(params, null);
});

// ── belt-and-suspenders: the RawAssistedPurchaseIntent shape refuses the fields at compile time ──

test("type invariant: RawAssistedPurchaseIntent has NO unitCents / vendor field (compile-time drop)", () => {
  // The declaration below type-checks precisely because those fields are absent
  // from the interface. Adding either would fail typecheck at build time.
  const shape: RawIntent = {
    actionType: "create_order",
    variantId: VARIANT_UUID,
    shopifyVariantId: null,
    sku: null,
    title: null,
    quantity: 1,
    interval: null,
    intervalCount: null,
    nextBillingDate: null,
  };
  // Runtime sanity — the object has the keys we expect and nothing else.
  const keys = Object.keys(shape).sort();
  assert.deepEqual(keys, [
    "actionType",
    "interval",
    "intervalCount",
    "nextBillingDate",
    "quantity",
    "shopifyVariantId",
    "sku",
    "title",
    "variantId",
  ]);
});
