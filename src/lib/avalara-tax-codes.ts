/**
 * Maps Shopify Standard Product Taxonomy category names → Avalara
 * AvaTax product codes.
 *
 * Code reference (Avalara public taxonomy):
 *   PF050144  Dietary supplements (Vitamins & Supplements branch)
 *   PC040100  Food and food ingredients for human consumption — used
 *             for unprepared coffee, creamer, K-cups, etc. Most US
 *             states tax groceries at a reduced rate or exempt them.
 *   P0000000  Tangible personal property — fully taxable generic
 *             merchandise (mugs, tumblers, drink mixers).
 *   OS010100  Shipping insurance / shipping protection. Many states
 *             do not tax this; Avalara handles the jurisdictional
 *             rules when this code is set.
 *
 * Returning `null` means "let Avalara default-classify it" — we use
 * that for the workspace default (PF050144 in our seed) plus any
 * truly unclassifiable item (e.g. internal "Mystery Item" SKU).
 *
 * Order of resolution at transaction time:
 *   1. product_variants.shopify_tax_code (Shopify Plus / Avalara field)
 *   2. products.avalara_tax_code (this classifier or manual override)
 *   3. workspaces.avalara_default_tax_code
 *   4. let Avalara guess from item description
 */

export type AvalaraClassification = {
  taxCode: string | null;
  bucket: "supplement" | "food" | "merchandise" | "shipping_protection" | "unknown";
  reason: string;
};

export function classifyByShopifyCategory(category: string | null | undefined, title: string | null | undefined = null): AvalaraClassification {
  const cat = (category || "").trim();
  const t = (title || "").toLowerCase();

  // Shipping protection is rarely categorized in Shopify; match by
  // title first since "Shipping Protection" lives under "Uncategorized".
  if (/shipping\s*protection|upcart|shopwill/i.test(t)) {
    return { taxCode: "OS010100", bucket: "shipping_protection", reason: "Title matches shipping protection" };
  }

  if (!cat) {
    return { taxCode: null, bucket: "unknown", reason: "No Shopify category" };
  }

  // Vitamins & Supplements (incl. Herbal, Creatine sub-branches)
  if (/Vitamins\s*&\s*Supplements/i.test(cat)) {
    return { taxCode: "PF050144", bucket: "supplement", reason: "Vitamins & Supplements category" };
  }

  // Coffee / creamer / pods — groceries
  if (/Beverages\s*>\s*Coffee/i.test(cat) || /Dairy Products\s*>\s*Coffee Creamer/i.test(cat) || /Coffee\s*Pods/i.test(cat)) {
    return { taxCode: "PC040100", bucket: "food", reason: "Coffee/creamer/pods → food & food ingredients" };
  }

  // Other Food, Beverages & Tobacco (excluding alcohol/tobacco branches we don't carry)
  if (/^Food,\s*Beverages\s*&\s*Tobacco/i.test(cat)) {
    return { taxCode: "PC040100", bucket: "food", reason: "Food, Beverages & Tobacco → food & food ingredients" };
  }

  // Home & Garden kitchen/drinkware — tangible personal property
  if (/^Home\s*&\s*Garden\s*>\s*Kitchen\s*&\s*Dining/i.test(cat)) {
    return { taxCode: "P0000000", bucket: "merchandise", reason: "Kitchen & dining merchandise → generic taxable" };
  }

  if (/^Home\s*&\s*Garden/i.test(cat)) {
    return { taxCode: "P0000000", bucket: "merchandise", reason: "Home & Garden merchandise → generic taxable" };
  }

  // Uncategorized — leave null so Avalara defaults / falls back to workspace default
  if (/^Uncategorized$/i.test(cat)) {
    return { taxCode: null, bucket: "unknown", reason: "Uncategorized in Shopify" };
  }

  return { taxCode: null, bucket: "unknown", reason: `Unmapped category: ${cat}` };
}
