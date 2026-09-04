/**
 * Rails for [[one-time-charge]].
 *
 * The address mapper is the piece worth pinning: `orders.shipping_address` is
 * Shopify-shaped (address1 / province_code / zip / country_code) and Avalara
 * wants line1 / region / postalCode / country. A silent mismatch here would
 * commit a SalesInvoice against a half-formed address — a real filing problem that
 * no type check catches, because both sides are strings.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { toAvalaraAddress } from "./one-time-charge";

test("maps a Shopify-shaped order address onto Avalara's field names", () => {
  const out = toAvalaraAddress({
    first_name: "Susan",
    address1: "210 Main St",
    address2: "Apt 4",
    city: "San Antonio",
    province_code: "TX",
    zip: "78205",
    country_code: "US",
  });
  assert.deepEqual(out, {
    line1: "210 Main St",
    line2: "Apt 4",
    city: "San Antonio",
    region: "TX",
    postalCode: "78205",
    country: "US",
  });
});

test("returns null on a half-formed address rather than committing tax against it", () => {
  // No state — Avalara cannot rate this, and a committed SalesInvoice against
  // it is worse than charging no tax.
  assert.equal(
    toAvalaraAddress({ address1: "210 Main St", city: "San Antonio", zip: "78205" }),
    null,
  );
  assert.equal(toAvalaraAddress(null), null);
  assert.equal(toAvalaraAddress({}), null);
});

test("omits line2 entirely when there is no second line", () => {
  const out = toAvalaraAddress({
    address1: "210 Main St",
    city: "San Antonio",
    province_code: "TX",
    zip: "78205",
  });
  assert.ok(out);
  assert.equal("line2" in out!, false, "an empty line2 must not be sent as a blank string");
  assert.equal(out!.country, "US", "country defaults to US when absent");
});
