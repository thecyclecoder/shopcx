/**
 * Engine address-distance signal tests. Parity against the legacy zip helpers
 * in src/lib/geo-distance.ts, plus the evaluator's legacy wording and edges.
 *
 * Run: npx tsx --test src/lib/engine/fraud/address-distance.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAddressDistance, zipDistance, extractZip } from "./index";
import { zipDistance as legacyZipDistance, extractZip as legacyExtractZip } from "../../geo-distance";

test("zip helpers match legacy geo-distance", () => {
  const pairs: Array<[string, string]> = [["10001", "90001"], ["44130", "44308"], ["10001", "10001"], ["00000", "10001"], ["1234", "10001"], ["10001-1234", "60601"]];
  for (const [a, b] of pairs) assert.equal(zipDistance(a, b), legacyZipDistance(a, b), `${a}→${b}`);
  const addrs = [{ zip: "44130-1234" }, { postal_code: "90001" }, { zip: "K1A 0B1" }, { zip: "" }, null];
  for (const a of addrs) assert.equal(extractZip(a), legacyExtractZip(a), JSON.stringify(a));
});

test("NYC billing, LA shipping → finding with legacy title + evidence", () => {
  const order = {
    shopify_order_id: "5550001",
    billing_address: { firstName: "A", city: "New York", province: "New York", zip: "10001" },
    shipping_address: { first_name: "A", city: "Los Angeles", province: "California", zip: "90001-0001" },
  };
  const f = evaluateAddressDistance(order, { distance_threshold_miles: 500 })!;
  assert.ok(f);
  const miles = Math.round(legacyZipDistance("10001", "90001")!);
  assert.equal(f.title, `Billing/shipping ${miles} miles apart on order #5550001`);
  assert.deepEqual(f.evidence, {
    billing_zip: "10001",
    shipping_zip: "90001",
    billing_address: "New York, New York",
    shipping_address: "Los Angeles, California",
    distance_miles: miles,
    threshold_miles: 500,
    order_id: "5550001",
  });
});

test("no finding: same zip, missing zip, unknown zip, or under the threshold", () => {
  const mk = (b: string | undefined, s: string | undefined) => ({ shopify_order_id: "1", billing_address: { zip: b }, shipping_address: { zip: s } });
  assert.equal(evaluateAddressDistance(mk("10001", "10001"), {}), null);
  assert.equal(evaluateAddressDistance(mk(undefined, "10001"), {}), null);
  assert.equal(evaluateAddressDistance({ shopify_order_id: "1", billing_address: null, shipping_address: { zip: "10001" } }, {}), null);
  assert.equal(evaluateAddressDistance(mk("00000", "10001"), {}), null);
  // Cleveland ↔ Akron is well under the 100-mile default
  assert.equal(evaluateAddressDistance(mk("44130", "44308"), null), null);
  // ...but a 0 threshold falls back to the default (legacy `|| 100`)
  assert.equal(evaluateAddressDistance(mk("44130", "44308"), { distance_threshold_miles: 0 }), null);
  assert.ok(evaluateAddressDistance(mk("44130", "44308"), { distance_threshold_miles: 5 }));
});

test("threshold is inclusive (legacy skips only when distance < threshold)", () => {
  const d = legacyZipDistance("44130", "44308")!;
  const order = { shopify_order_id: "1", billing_address: { zip: "44130" }, shipping_address: { zip: "44308" } };
  assert.ok(evaluateAddressDistance(order, { distance_threshold_miles: d }));
  assert.equal(evaluateAddressDistance(order, { distance_threshold_miles: d + 0.001 }), null);
});
