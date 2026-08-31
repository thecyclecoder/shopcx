/**
 * Maps Shopify Standard Product Taxonomy category names → Avalara
 * AvaTax product codes.
 *
 * Code reference — every code below was verified against Avalara's own
 * /definitions/taxcodes endpoint on 2026-08-31. Do NOT add a code from memory:
 * an unrecognised code is not rejected, it is SILENTLY degraded to P0000000
 * (fully taxable) and the mistake only shows up as customer overcharges.
 *
 *   PF050700  Food And Food Ingredients-dietary supplements (supplement facts
 *             on label). Exempt in NY/TX, taxable in CA — Avalara applies the
 *             per-jurisdiction rule.
 *   PF050002  Food And Food Ingredients - Food for Home Consumption or Basic
 *             Groceries — unprepared coffee, creamer, K-cups.
 *   P0000000  Tangible personal property — fully taxable generic
 *             merchandise (mugs, tumblers, drink mixers).
 *   OS010100  Shipping insurance / shipping protection. Many states
 *             do not tax this; Avalara handles the jurisdictional
 *             rules when this code is set.
 *
 * Returning `null` means "let Avalara default-classify it" — we use that for
 * any truly unclassifiable item (e.g. the internal "Mystery Item" SKU). The
 * workspace default is P0000000: an unclassified product must fall back to
 * fully taxable, never inherit an exemption it may not be entitled to.
 *
 * ⚠️ 2026-08-31 incident. This file previously mapped supplements to PF050144
 * and food to PC040100. PF050144 does not exist in Avalara's taxonomy at all,
 * so every supplement was taxed as general merchandise; PC040100 is
 * "Clothing And Related Products", so coffee was taking a clothing exemption.
 * Found via Laura Light's ticket (295cc934) after she was charged $8.44 of NY
 * sales tax on a dietary supplement three times running.
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
    return { taxCode: "PF050700", bucket: "supplement", reason: "Vitamins & Supplements category" };
  }

  // Coffee / creamer / pods — groceries
  if (/Beverages\s*>\s*Coffee/i.test(cat) || /Dairy Products\s*>\s*Coffee Creamer/i.test(cat) || /Coffee\s*Pods/i.test(cat)) {
    return { taxCode: "PF050002", bucket: "food", reason: "Coffee/creamer/pods → food for home consumption" };
  }

  // Other Food, Beverages & Tobacco (excluding alcohol/tobacco branches we don't carry)
  if (/^Food,\s*Beverages\s*&\s*Tobacco/i.test(cat)) {
    return { taxCode: "PF050002", bucket: "food", reason: "Food, Beverages & Tobacco → food for home consumption" };
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
