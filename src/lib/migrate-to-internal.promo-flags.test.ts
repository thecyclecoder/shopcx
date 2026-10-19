/**
 * Appstle promo-line flags → migration treatment. Ground truth: every flagged line in the
 * stored contract snapshots is the $0 ACV Gummies bonus carrying BOTH attributes, which the
 * migration used to carry over as a PAID recurring line (sub 25afd98d, $27.57 on SHOPCX426).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appstlePromoFlags, appstleLinesToInternalItems } from "./migrate-to-internal";

const attr = (key: string, value: string) => ({ key, value, __typename: "Attribute" });

// Minimal chainable Supabase stub: every .from(table).select().eq()… resolves to the
// row registered for that table (or null). Enough for appstleLinesToInternalItems, which
// only reads product_variants (variant resolve) + workspaces/product_pricing_rule/pricing_rules
// (resolveLineSnsPct). The zero_price_line exclusion fires before any DB read.
type Row = Record<string, unknown> | null;
function fakeAdmin(byTable: Record<string, Row>) {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => ({ data: byTable[table] ?? null }),
    };
    return b;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (t: string) => builder(t) } as any;
}

test("ground-truth ACV bonus line → free + one-time (never carried over)", () => {
  const line = {
    title: "ACV Gummies",
    currentPrice: { amount: "0.0" },
    pricingPolicy: null,
    customAttributes: [attr("_appstle-free-product", "true"), attr("_appstle-one-time-product", "true")],
  };
  assert.deepEqual(appstlePromoFlags(line), { freeProduct: true, oneTime: true });
});

test("free-only line → recurring free gift", () => {
  assert.deepEqual(
    appstlePromoFlags({ customAttributes: [attr("_appstle-free-product", "true")] }),
    { freeProduct: true, oneTime: false },
  );
});

test("regular paid line (no attributes / other attributes / false values) → no flags", () => {
  const none = { freeProduct: false, oneTime: false };
  assert.deepEqual(appstlePromoFlags({}), none);
  assert.deepEqual(appstlePromoFlags({ customAttributes: null }), none);
  assert.deepEqual(appstlePromoFlags({ customAttributes: [attr("_some-other", "true")] }), none);
  assert.deepEqual(
    appstlePromoFlags({ customAttributes: [attr("_appstle-free-product", "false"), attr("_appstle-one-time-product", "false")] }),
    none,
  );
});

test("value matching is case-insensitive ('TRUE')", () => {
  assert.equal(appstlePromoFlags({ customAttributes: [attr("_appstle-one-time-product", "TRUE")] }).oneTime, true);
});

// ── Phase 1: unflagged $0 line excluded as zero_price_line ──────────────────────
// Ground truth: the Handheld Drink Mixer ASC-MIX-1 one-time gift (sub ed9b0771, Appstle
// contract 27818131629) is $0 with NO free/one-time attribute, so it fell through both
// promo paths and the internal engine billed it at catalog ($14.96) every cycle.

test("unflagged $0 line → excluded with reason zero_price_line (never migrated)", async () => {
  const admin = fakeAdmin({}); // not touched — exclusion fires before any catalog lookup
  const { items, excludedLines } = await appstleLinesToInternalItems(admin, "ws1", [
    {
      title: "Handheld Drink Mixer",
      variantId: "gid://shopify/ProductVariant/44444",
      sku: "ASC-MIX-1",
      quantity: 1,
      currentPrice: { amount: "0.00" },
      lineDiscountedPrice: { amount: "0.00" },
      customAttributes: [],
    },
  ]);
  assert.equal(items.length, 0);
  assert.equal(excludedLines.length, 1);
  assert.equal(excludedLines[0].reason, "zero_price_line");
  assert.equal(excludedLines[0].title, "Handheld Drink Mixer");
});

test("flagged free recurring line still lands as is_gift (freeProduct path unchanged)", async () => {
  const admin = fakeAdmin({
    product_variants: { id: "v-gift", product_id: "p-gift", price_cents: 2000, title: "Gift", sku: "GIFT-1" },
  });
  const { items, excludedLines } = await appstleLinesToInternalItems(admin, "ws1", [
    {
      title: "Recurring Gift",
      variantId: "gid://shopify/ProductVariant/55555",
      sku: "GIFT-1",
      quantity: 1,
      currentPrice: { amount: "0.00" },
      lineDiscountedPrice: { amount: "0.00" },
      customAttributes: [attr("_appstle-free-product", "true")],
    },
  ]);
  assert.equal(excludedLines.length, 0);
  assert.equal(items.length, 1);
  assert.equal(items[0].is_gift, true);
  assert.equal(items[0].variant_id, "v-gift");
});

test("paid line is untouched (lands as a normal priced item)", async () => {
  const admin = fakeAdmin({
    product_variants: { id: "v-paid", product_id: "p-paid", price_cents: 2000, title: "Coffee", sku: "COF-1" },
    workspaces: { subscription_discount_pct: 25 },
    product_pricing_rule: null,
  });
  const { items, excludedLines } = await appstleLinesToInternalItems(admin, "ws1", [
    {
      title: "Coffee",
      variantId: "gid://shopify/ProductVariant/66666",
      sku: "COF-1",
      quantity: 2,
      currentPrice: { amount: "20.00" },
      lineDiscountedPrice: { amount: "20.00" },
      pricingPolicy: null,
      customAttributes: [],
    },
  ]);
  assert.equal(excludedLines.length, 0);
  assert.equal(items.length, 1);
  assert.equal(items[0].is_gift, undefined);
  assert.equal(items[0].variant_id, "v-paid");
  assert.equal(items[0].quantity, 2);
});
