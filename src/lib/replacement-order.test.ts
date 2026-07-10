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
import { buildReplacementDraftOrderInput, type CreateReplacementInput } from "./replacement-order";

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
