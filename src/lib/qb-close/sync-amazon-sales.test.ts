/**
 * Pins `parseShippedUnits` — the shipped-vs-ordered rule that is the whole reason this module
 * exists separately from `amazon/sync-orders.ts`.
 *
 * The wedge: ShopCX's analytics parser counts Shipped + Shipping + PENDING (a demand question);
 * the close may only count units that actually left a warehouse (an inventory question). For
 * July 2026 those differ by 35% — 803 ordered vs 597 shipped — so wiring the analytics table into
 * the close would have overstated Amazon burn and COGS by a third.
 *
 * Run: npx tsx --test src/lib/qb-close/sync-amazon-sales.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseShippedUnits } from "./sync-amazon-sales";

const HEADERS = ["amazon-order-id", "purchase-date", "order-status", "sku", "asin", "product-name", "quantity", "item-price", "promotion-ids"];
const row = (o: Partial<Record<string, string>>) =>
  HEADERS.map((h) => o[h] ?? "").join("\t");
const tsv = (...rows: string[]) => [HEADERS.join("\t"), ...rows].join("\n");

const base = { "purchase-date": "2026-07-15T10:00:00+00:00", sku: "SC-X", asin: "B01", quantity: "2", "item-price": "50.00" };

test("counts Shipped and Shipping, EXCLUDES Pending and Cancelled", () => {
  const { byKey, excluded } = parseShippedUnits(
    tsv(
      row({ ...base, "order-status": "Shipped" }),
      row({ ...base, "order-status": "Shipping" }),
      row({ ...base, "order-status": "Pending" }),
      row({ ...base, "order-status": "Cancelled" }),
    ),
  );
  const agg = byKey.get("B01|2026-07-15")!;
  assert.equal(agg.units, 4, "only the 2 shipped rows (2+2) should count");
  assert.equal(excluded, 4, "pending + cancelled units are reported, not silently dropped");
});

test("status matching is case-insensitive", () => {
  const { byKey } = parseShippedUnits(tsv(row({ ...base, "order-status": "SHIPPED" }), row({ ...base, "order-status": "shipping" })));
  assert.equal(byKey.get("B01|2026-07-15")!.units, 4);
});

test("groups by (asin, sale_date) and buckets by promotion", () => {
  const { byKey } = parseShippedUnits(
    tsv(
      row({ ...base, "order-status": "Shipped", "promotion-ids": "FBA Subscribe & Save Discount" }),
      row({ ...base, "order-status": "Shipped", "promotion-ids": "Subscribe and Save Promotion V2" }),
      row({ ...base, "order-status": "Shipped", "promotion-ids": "" }),
      row({ ...base, "order-status": "Shipped", asin: "B02" }),
      row({ ...base, "order-status": "Shipped", "purchase-date": "2026-07-16T09:00:00+00:00" }),
    ),
  );
  const a = byKey.get("B01|2026-07-15")!;
  assert.equal(a.units, 6);
  assert.equal(a.recurringUnits, 2);
  assert.equal(a.snsUnits, 2);
  assert.equal(a.oneTimeUnits, 2);
  assert.equal(a.recurringUnits + a.snsUnits + a.oneTimeUnits, a.units, "buckets must sum to total");
  assert.ok(byKey.has("B02|2026-07-15"), "a different ASIN is its own group");
  assert.ok(byKey.has("B01|2026-07-16"), "a different day is its own group");
});

test("matches Amazon's '&' spelling of the S&S promotion", () => {
  // Amazon writes "&" in the report data; the "and" spelling appears in docs. Both must bucket
  // as recurring or subscription revenue silently lands in one_time.
  for (const promo of ["FBA Subscribe & Save Discount", "FBA Subscribe and Save Discount"]) {
    const { byKey } = parseShippedUnits(tsv(row({ ...base, "order-status": "Shipped", "promotion-ids": promo })));
    assert.equal(byKey.get("B01|2026-07-15")!.recurringUnits, 2, promo);
  }
});

test("skips zero-quantity, blank-asin and blank-date rows without throwing", () => {
  const { byKey } = parseShippedUnits(
    tsv(
      row({ ...base, "order-status": "Shipped", quantity: "0" }),
      row({ ...base, "order-status": "Shipped", asin: "" }),
      row({ ...base, "order-status": "Shipped", "purchase-date": "" }),
      row({ ...base, "order-status": "Shipped" }),
    ),
  );
  assert.equal(byKey.size, 1);
  assert.equal(byKey.get("B01|2026-07-15")!.units, 2);
});

test("an empty or header-only report yields nothing rather than throwing", () => {
  assert.equal(parseShippedUnits("").byKey.size, 0);
  assert.equal(parseShippedUnits(HEADERS.join("\t")).byKey.size, 0);
});
