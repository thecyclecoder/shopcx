/**
 * Unit tests for `buildShopifyPurchaseEvent` — the Shopify → Meta CAPI Purchase builder.
 *
 * The renewal filter is the rule with money behind it. Of ~435 weekly Shopify orders only
 * ~45 are new web checkouts; the rest are subscription renewals. Forwarding those as ad
 * conversions would inflate acquisition ROAS ~10x and steer Meta's optimiser toward people
 * who already subscribe. Founder rule 2026-09-02: renewals NEVER send.
 *
 * The dedup id is the other load-bearing assertion: it must match, byte for byte, what the
 * web pixel emits on `checkout_completed` (`shopify_purchase_${checkout.order.id}`), or Meta
 * counts every purchase twice instead of collapsing the pair.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShopifyPurchaseEvent, CAPI_ALLOWED_SOURCE_NAMES } from "@/lib/meta-capi-shopify-purchase";

function order(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 6123456789012,
    checkout_token: "06dccb9c0c53ef6ddc755579e91dbb72",
    source_name: "web",
    total_price: "49.00",
    currency: "USD",
    email: "Buyer@Example.com",
    created_at: "2026-09-02T15:04:05Z",
    order_status_url: "https://superfoodscompany.com/orders/abc",
    customer: { id: 771234, email: "buyer@example.com", first_name: "Ada", last_name: "Lovelace" },
    shipping_address: { first_name: "Ada", last_name: "Lovelace", city: "Austin", province_code: "TX", zip: "78701", country_code: "US", phone: "555-123-4567" },
    line_items: [{ sku: "CRE-PRIME-BC", product_id: 42, quantity: 2 }],
    ...over,
  };
}

test("a new web checkout sends", () => {
  const d = buildShopifyPurchaseEvent(order());
  assert.equal(d.send, true);
  assert.equal(d.event?.eventName, "Purchase");
});

test("RENEWALS NEVER SEND — every renewal source_name is refused", () => {
  for (const src of ["subscription_contract_checkout_one", "internal_subscription_renewal"]) {
    const d = buildShopifyPurchaseEvent(order({ source_name: src }));
    assert.equal(d.send, false, `${src} must not send`);
    assert.equal(d.reason, "not_web_source");
  }
});

test("an UNKNOWN source_name fails closed (positive allowlist, not a denylist)", () => {
  // A new Shopify channel we've never seen must default to NOT sending, so a
  // future renewal-ish source can't leak in silently.
  for (const src of ["pos", "shopify_draft_order", "338004148225", "some_new_channel_2027", ""]) {
    const d = buildShopifyPurchaseEvent(order({ source_name: src }));
    assert.equal(d.send, false, `${JSON.stringify(src)} must not send`);
    assert.equal(d.reason, "not_web_source");
  }
  const missing = buildShopifyPurchaseEvent(order({ source_name: undefined }));
  assert.equal(missing.send, false);
  assert.equal(missing.reason, "not_web_source");
  assert.deepEqual([...CAPI_ALLOWED_SOURCE_NAMES], ["web"]);
});

test("event id keys on the CHECKOUT TOKEN, matching the web pixel", () => {
  const d = buildShopifyPurchaseEvent(order());
  // The pixel emits `shopify_purchase_${checkout.token}`. It must NOT be the order id:
  // the pixel's `checkout.order.id` returns an opaque Meta token at runtime
  // ("EII1|AQAA…"), so keying on the order id gave the two paths DIFFERENT ids and
  // every purchase was counted twice (observed in production 2026-09-04).
  assert.equal(d.event?.eventId, "shopify_purchase_06dccb9c0c53ef6ddc755579e91dbb72");
});

test("falls back to the order id when no checkout token is present", () => {
  // Sends (won't dedup) rather than being dropped entirely.
  const d = buildShopifyPurchaseEvent(order({ checkout_token: undefined }));
  assert.equal(d.send, true);
  assert.equal(d.event?.eventId, "shopify_purchase_6123456789012");
});

test("browser identifiers come off the order when the caller has none", () => {
  // A webhook is server-to-server: no cookies, no IP. Shopify records the real
  // browser IP/UA on the order, and the theme stashes _fbp/_fbc in note_attributes.
  const d = buildShopifyPurchaseEvent(order({
    browser_ip: "203.0.113.9",
    client_details: { user_agent: "Mozilla/5.0 (iPhone)" },
    note_attributes: [
      { name: "_fbp", value: "fb.1.1700000000000.123" },
      { name: "_fbc", value: "fb.1.1700000000000.IwAR_x" },
    ],
  }));
  const ud = d.event!.userData;
  assert.equal(ud.clientIp, "203.0.113.9");
  assert.equal(ud.clientUserAgent, "Mozilla/5.0 (iPhone)");
  assert.equal(ud.fbp, "fb.1.1700000000000.123");
  assert.equal(ud.fbc, "fb.1.1700000000000.IwAR_x");
});

test("test orders and zero-value orders are refused", () => {
  assert.equal(buildShopifyPurchaseEvent(order({ test: true })).reason, "test_order");
  assert.equal(buildShopifyPurchaseEvent(order({ total_price: "0.00" })).reason, "zero_value");
  assert.equal(buildShopifyPurchaseEvent(order({ id: undefined })).reason, "no_order_id");
});

test("match keys are pulled from the order for maximum EMQ", () => {
  const ud = buildShopifyPurchaseEvent(order()).event!.userData;
  assert.equal(ud.email, "Buyer@Example.com"); // normalized + hashed downstream
  assert.equal(ud.phone, "555-123-4567");
  assert.equal(ud.firstName, "Ada");
  assert.equal(ud.lastName, "Lovelace");
  assert.equal(ud.city, "Austin");
  assert.equal(ud.state, "TX");
  assert.equal(ud.zip, "78701");
  assert.equal(ud.country, "US");
  assert.equal(ud.externalId, "771234");
});

test("fbclid is converted into an _fbc when no cookie was captured", () => {
  const d = buildShopifyPurchaseEvent(order(), { fbclid: "IwAR_abc", nowMs: 1_700_000_000_000 });
  assert.equal(d.event?.userData.fbc, "fb.1.1700000000000.IwAR_abc");
});

test("custom_data carries value, currency, skus and item count", () => {
  const cd = buildShopifyPurchaseEvent(order()).event!.customData!;
  assert.equal(cd.value, 49);
  assert.equal(cd.currency, "USD");
  assert.deepEqual(cd.content_ids, ["CRE-PRIME-BC"]);
  assert.equal(cd.num_items, 2);
  assert.equal(cd.order_id, "6123456789012");
});

test("event_time comes from the order's created_at, not wall clock", () => {
  const d = buildShopifyPurchaseEvent(order({ created_at: "2026-09-02T15:04:05Z" }));
  assert.equal(d.event?.eventTimeSec, Math.floor(Date.parse("2026-09-02T15:04:05Z") / 1000));
});
