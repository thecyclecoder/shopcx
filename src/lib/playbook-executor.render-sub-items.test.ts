/**
 * Pins `renderSubItemsWithVariants` — Phase 5 of
 * [[../../docs/brain/specs/every-inbound-handled-within-30-min]]. Two flavors of the same
 * product must render as "Superfood Tabs in Peach Mango and Mixed Berry", not
 * "Superfood Tabs and Superfood Tabs" (ticket cc3d6b9b).
 *
 * Run: npx tsx --test src/lib/playbook-executor.render-sub-items.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderSubItemsWithVariants } from "./playbook-executor";

test("two flavors of ONE product collapse to '<Product> in <A> and <B>'", () => {
  const items = [
    { title: "Superfood Tabs", variant_title: "Peach Mango" },
    { title: "Superfood Tabs", variant_title: "Mixed Berry" },
  ];
  assert.equal(
    renderSubItemsWithVariants(items),
    "Superfood Tabs in Peach Mango and Mixed Berry",
  );
});

test("three flavors of ONE product render with Oxford commas", () => {
  const items = [
    { title: "Superfood Tabs", variant_title: "Peach Mango" },
    { title: "Superfood Tabs", variant_title: "Mixed Berry" },
    { title: "Superfood Tabs", variant_title: "Original" },
  ];
  assert.equal(
    renderSubItemsWithVariants(items),
    "Superfood Tabs in Peach Mango, Mixed Berry, and Original",
  );
});

test("two different products EACH with a flavor render as per-line '<Product> in <variant>'", () => {
  const items = [
    { title: "Superfood Tabs", variant_title: "Peach Mango" },
    { title: "Energy Mix", variant_title: "Berry" },
  ];
  assert.equal(
    renderSubItemsWithVariants(items),
    "Superfood Tabs in Peach Mango and Energy Mix in Berry",
  );
});

test("missing variant_title falls back to the bare product title (no 'in null')", () => {
  const items = [{ title: "Protein Shake" }, { title: "Energy Mix" }];
  assert.equal(renderSubItemsWithVariants(items), "Protein Shake and Energy Mix");
});

test("Shopify 'Default Title' variant is treated as no flavor (no 'in Default Title')", () => {
  const items = [{ title: "Protein Shake", variant_title: "Default Title" }];
  assert.equal(renderSubItemsWithVariants(items), "Protein Shake");
});

test("empty or missing items fall back to 'your products' (never a bare '')", () => {
  assert.equal(renderSubItemsWithVariants([]), "your products");
  assert.equal(renderSubItemsWithVariants(null), "your products");
  assert.equal(renderSubItemsWithVariants(undefined), "your products");
});
