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
  decideOverCap,
  findVariantOverCap,
  normalizeReplacementReasonTag,
  REPLACEMENT_MAX_UNITS_PER_VARIANT,
  REPLACEMENT_REASON_TAG_MAX_LEN,
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

test("a 62-char free-form reason NEVER produces a >40-char tag — no more 'Title Tag exceeds the maximum length of 40 characters' (2026-08-02)", () => {
  const input = baseInput();
  input.items = [{ variantId: "v", quantity: 1 }];
  // The exact class of reason that failed a real replacement on 2026-08-02:
  // a Sonnet-authored prose sentence longer than Shopify's 40-char tag ceiling.
  input.reason = "Customer received two damaged bottles, one leaking";
  const out = buildReplacementDraftOrderInput(input, "US", "https://shopcx.ai");
  assert.equal(out.tags[0], "replacement");
  assert.ok(
    out.tags[1].length <= REPLACEMENT_REASON_TAG_MAX_LEN,
    `reason tag must be <= ${REPLACEMENT_REASON_TAG_MAX_LEN} chars; got ${out.tags[1].length} (${out.tags[1]})`,
  );
});

test("normalizeReplacementReasonTag — codes idempotent, prose slugified, blank → 'unspecified', long → truncated", () => {
  assert.equal(normalizeReplacementReasonTag("not_received"), "not_received");
  assert.equal(normalizeReplacementReasonTag("damaged_items"), "damaged_items");
  assert.equal(normalizeReplacementReasonTag("Damaged Items"), "damaged_items");
  assert.equal(normalizeReplacementReasonTag(""), "unspecified");
  assert.equal(normalizeReplacementReasonTag(null), "unspecified");
  const long = "a".repeat(80);
  assert.equal(normalizeReplacementReasonTag(long).length, REPLACEMENT_REASON_TAG_MAX_LEN);
});

test("shopifyNote is NOT hardcoded — a caller who passes no note gets the neutral fallback, not 'crisis swap compensation'", () => {
  const input = baseInput();
  input.items = [{ variantId: "v", quantity: 1 }];
  // Explicitly clear shopifyNote to prove the SDK default is neutral; the
  // action-executor caller now passes `p.reason` (the explanation) here,
  // never the 2026-08-02 hardcoded 'crisis swap compensation' string.
  input.shopifyNote = undefined;
  const out = buildReplacementDraftOrderInput(input, "US", "https://shopcx.ai");
  assert.doesNotMatch(out.note, /crisis swap compensation/i);
  assert.match(out.note, /Replacement order/);
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

// ── The per-variant cap and its founder grant (decideOverCap) ────────────────
//
// Ground truth: Jen Parker (ticket b199e5ba). 14 paid orders since 2024, $3,386 lifetime, and every
// order she has placed is 5-6 units. Her whole 5-unit bulk order of Superfood Tabs arrived expired.
// June escalated it as "a real over-cap authorization only the founder can grant" — and before
// 2026-08-28 there was nothing to grant it WITH: the cap refused every caller, including the CEO.
// She waited 23 days. The grant exists so a supervisor can approve an exception; the tool still can't.

test("within the cap — allowed, and not marked as a granted exception", () => {
  const d = decideOverCap([{ variantId: "v1", quantity: 4 }]);
  assert.equal(d.allow, true);
  assert.equal(d.granted, false);
});

test("over the cap with NO authorizer — refused, as it is for every autonomous caller", () => {
  const d = decideOverCap([{ variantId: "v1", quantity: 5, title: "Mixed Berry" }]);
  assert.equal(d.allow, false);
  if (d.allow) return;
  assert.match(d.refusal, /exceeds the per-variant cap of 4/);
  assert.match(d.refusal, /Mixed Berry/);
  assert.equal(d.over.requested, 5);
});

test("over the cap WITH a named authorizer — allowed, flagged granted, authorizer preserved", () => {
  const who = "Dylan Ralston (founder) 2026-08-28 — CEO approvals ruling on ticket b199e5ba";
  const d = decideOverCap([{ variantId: "42614433448109", quantity: 5, title: "Mixed Berry" }], who);
  assert.equal(d.allow, true);
  assert.equal(d.granted, true);
  if (!d.granted) return;
  assert.equal(d.authorizedBy, who);
  assert.equal(d.over.requested, 5);
  assert.equal(d.over.cap, REPLACEMENT_MAX_UNITS_PER_VARIANT);
});

test("a blank authorizer is NOT a grant — the exception must name a human", () => {
  for (const blank of ["", "   ", undefined, null]) {
    const d = decideOverCap([{ variantId: "v1", quantity: 9 }], blank as string | null | undefined);
    assert.equal(d.allow, false, `blank authorizer ${JSON.stringify(blank)} must not grant`);
  }
});

test("the grant is per-request, not a global cap raise — an un-granted call still refuses after a granted one", () => {
  const granted = decideOverCap([{ variantId: "v1", quantity: 5 }], "founder");
  assert.equal(granted.allow, true);
  const next = decideOverCap([{ variantId: "v1", quantity: 5 }]);
  assert.equal(next.allow, false);
});

test("quantities still sum per variant before the cap is applied — 3+3 of one variant is over", () => {
  const d = decideOverCap([{ variantId: "v1", quantity: 3 }, { variantId: "v1", quantity: 3 }]);
  assert.equal(d.allow, false);
  if (d.allow) return;
  assert.equal(d.over.requested, 6);
});

test("a multi-flavour 4+4 is still fine — the cap is per variant, not per order", () => {
  const d = decideOverCap([{ variantId: "v1", quantity: 4 }, { variantId: "v2", quantity: 4 }]);
  assert.equal(d.allow, true);
  assert.equal(d.granted, false);
});
