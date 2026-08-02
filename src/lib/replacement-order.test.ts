/**
 * Regression pins for [[replacement-order]]. Phase 2 focus:
 * multi-item replacement = ONE order with N line items — Evan H.'s
 * SC132221 Peach Mango + Strawberry Lemonade replacement previously
 * fragmented into TWO free orders (SC134462 + SC134463) because the
 * direct-action handler was single-item and Sonnet looped once per
 * flavor. The pure builder now maps 1:1 from `input.items[]` into
 * Shopify DraftOrderInput.lineItems, and this pins the invariant.
 *
 * Run: npx tsx --test src/lib/replacement-order.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReplacementDraftOrderInput,
  findVariantOverCap,
  REPLACEMENT_MAX_UNITS_PER_VARIANT,
  type CreateReplacementInput,
} from "./replacement-order";

const ADDR: CreateReplacementInput["shippingAddress"] = {
  firstName: "Evan", lastName: "H",
  address1: "1 Somewhere St", address2: "",
  city: "Anytown", province: "OR", provinceCode: "OR",
  zip: "97000", countryCode: "US",
};

function baseInput(): Pick<CreateReplacementInput, "items" | "shippingAddress" | "shopifyCustomerId" | "reason" | "ticketId" | "shopifyNote"> {
  return {
    shopifyCustomerId: "1234567890",
    items: [],
    shippingAddress: ADDR,
    reason: "damaged_items",
    ticketId: null,
    shopifyNote: "Replacement order",
  };
}

test("[SC132221] two distinct flavors → ONE draftOrderInput with 2 line items (not two separate orders)", () => {
  const input = baseInput();
  input.items = [
    { variantId: "42614433513645", quantity: 1, title: "Peach Mango" },
    { variantId: "42614433546413", quantity: 1, title: "Strawberry Lemonade" },
  ];
  const out = buildReplacementDraftOrderInput(input, "US", "https://shopcx.ai");
  assert.equal(out.lineItems.length, 2, "one draft order MUST carry both flavors as line items");
  assert.equal(out.lineItems[0].variantId, "gid://shopify/ProductVariant/42614433513645");
  assert.equal(out.lineItems[0].quantity, 1);
  assert.equal(out.lineItems[1].variantId, "gid://shopify/ProductVariant/42614433546413");
  assert.equal(out.lineItems[1].quantity, 1);
});

test("single-item back-compat — 1 item still yields exactly one draft order with one line item", () => {
  const input = baseInput();
  input.items = [{ variantId: "42614433513645", quantity: 1, title: "Peach Mango" }];
  const out = buildReplacementDraftOrderInput(input, "US", "https://shopcx.ai");
  assert.equal(out.lineItems.length, 1);
  assert.equal(out.lineItems[0].variantId, "gid://shopify/ProductVariant/42614433513645");
  assert.equal(out.lineItems[0].quantity, 1);
});

test("mixed quantities preserved per line item — 2x A + 1x B → one draft order, lineItems=[{qty 2},{qty 1}]", () => {
  const input = baseInput();
  input.items = [
    { variantId: "vA", quantity: 2 },
    { variantId: "vB", quantity: 1 },
  ];
  const out = buildReplacementDraftOrderInput(input, "US", "https://shopcx.ai");
  assert.equal(out.lineItems.length, 2);
  assert.deepEqual(out.lineItems.map(i => i.quantity), [2, 1]);
  assert.deepEqual(out.lineItems.map(i => i.variantId), [
    "gid://shopify/ProductVariant/vA",
    "gid://shopify/ProductVariant/vB",
  ]);
});

test("countryCode uses the caller-resolved value (Phase 1 hand-off) — not sliced-from-name here", () => {
  const input = baseInput();
  input.items = [{ variantId: "42614433513645", quantity: 1 }];
  const out = buildReplacementDraftOrderInput(input, "CA", "https://shopcx.ai");
  assert.equal(out.shippingAddress.countryCode, "CA");
});

test("ticketLink appended to note when ticketId is set — Sonnet operator can jump to the ticket from Shopify", () => {
  const input = baseInput();
  input.items = [{ variantId: "42614433513645", quantity: 1 }];
  input.ticketId = "tkt-abc";
  const out = buildReplacementDraftOrderInput(input, "US", "https://shopcx.ai");
  assert.match(out.note, /Replacement order/);
  assert.match(out.note, /Ticket: https:\/\/shopcx\.ai\/dashboard\/tickets\/tkt-abc/);
});

test("no ticketLink when ticketId is null — no dangling ' Ticket: ' fragment", () => {
  const input = baseInput();
  input.items = [{ variantId: "42614433513645", quantity: 1 }];
  input.ticketId = null;
  const out = buildReplacementDraftOrderInput(input, "US", "https://shopcx.ai");
  assert.doesNotMatch(out.note, /Ticket:/);
});

test("tags carry the reason so Shopify surfaces it — ['replacement', <reason>]", () => {
  const input = baseInput();
  input.items = [{ variantId: "42614433513645", quantity: 1 }];
  input.reason = "not_received";
  const out = buildReplacementDraftOrderInput(input, "US", "https://shopcx.ai");
  assert.deepEqual(out.tags, ["replacement", "not_received"]);
});

test("100% discount always applied — the replacement ships FREE", () => {
  const input = baseInput();
  input.items = [{ variantId: "v1", quantity: 1 }];
  const out = buildReplacementDraftOrderInput(input, "US", "https://shopcx.ai");
  assert.equal(out.appliedDiscount.value, 100);
  assert.equal(out.appliedDiscount.valueType, "PERCENTAGE");
});

// ── Phase 1: REPLACEMENT_MAX_UNITS_PER_VARIANT cap ─────────────────
// A single variant may not ship more than 4 units per replacement. The
// CEO set this on 2026-08-02 while resolving a non-delivery make-whole
// (that ticket could have shipped 12 units of one variant unbounded).
// The cap lives in the SDK so every caller inherits it — a cap in one
// caller is a cap the next caller does not have.
test("cap constant is exactly 4 units per variant", () => {
  assert.equal(REPLACEMENT_MAX_UNITS_PER_VARIANT, 4);
});

test("findVariantOverCap: at-cap (qty 4) passes — 4 is allowed, only >4 refuses", () => {
  const over = findVariantOverCap([{ variantId: "vA", quantity: 4, title: "Peach Mango" }]);
  assert.equal(over, null);
});

test("findVariantOverCap: single line over cap (qty 5) is refused with variant + requested", () => {
  const over = findVariantOverCap([{ variantId: "vA", quantity: 5, title: "Peach Mango" }]);
  assert.ok(over, "5 units of one variant must be over the cap");
  assert.equal(over!.variantId, "vA");
  assert.equal(over!.title, "Peach Mango");
  assert.equal(over!.requested, 5);
  assert.equal(over!.cap, 4);
});

test("findVariantOverCap: legitimate 4+4 multi-flavour replacement is fine (per-variant, not per-order)", () => {
  // CEO's distinction: 4 + 4 across two flavours is fine; the cap is
  // per variant. This test pins that a caller passing 4 of A + 4 of B
  // is NOT refused.
  const over = findVariantOverCap([
    { variantId: "vA", quantity: 4, title: "Peach Mango" },
    { variantId: "vB", quantity: 4, title: "Strawberry Lemonade" },
  ]);
  assert.equal(over, null);
});

test("findVariantOverCap: sums duplicate variantIds across line items — 3 + 3 of the same variant is over cap", () => {
  // The CEO intent is 'no more than 4 of one variant'. Two line items
  // for the same variant summing above the cap must still refuse — the
  // check is per-variant, not per-line.
  const over = findVariantOverCap([
    { variantId: "vA", quantity: 3, title: "Peach Mango" },
    { variantId: "vA", quantity: 3 },
  ]);
  assert.ok(over, "3 + 3 of the same variant must be over the cap");
  assert.equal(over!.variantId, "vA");
  assert.equal(over!.requested, 6);
  assert.equal(over!.title, "Peach Mango");
});

test("findVariantOverCap: empty items → no over-cap variant (defensive)", () => {
  assert.equal(findVariantOverCap([]), null);
});

test("findVariantOverCap: variant without a title still refuses with a usable identifier", () => {
  const over = findVariantOverCap([{ variantId: "vX", quantity: 12 }]);
  assert.ok(over);
  assert.equal(over!.variantId, "vX");
  assert.equal(over!.title, null);
  assert.equal(over!.requested, 12);
});
