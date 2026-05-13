// Seed supplement_facts for the three known Amazing Coffee variants
// from the panel screenshots provided. Stored per-variant on
// product_variants.supplement_facts (JSONB).
//
// Shape:
//   serving_size, servings_per_container,
//   nutrients[] (name, amount, daily_value, indent),
//   proprietary_blend { amount, daily_value, ingredients },
//   footer_notes[], other_ingredients
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const STANDARD_FOOTER = [
  "*Percent Daily Values are based on a 2,000 calorie diet.",
  "**Daily value not established.",
];

// Macros + minerals are identical across the three variants — only
// the serving size, count, ingredients narrative, and "Other
// Ingredients" line differ.
const BASE_NUTRIENTS = [
  { name: "Calories", amount: "20", daily_value: null, indent: 0 },
  { name: "Total Carbohydrate", amount: "5 g", daily_value: "2%*", indent: 0 },
  { name: "Dietary Fiber", amount: "3 g", daily_value: "11%*", indent: 1 },
  { name: "Iron", amount: "0.9 mg", daily_value: "5%", indent: 0 },
  { name: "Potassium", amount: "180 mg", daily_value: "4%", indent: 0 },
];

// Cocoa (Instant): rich ingredient names with binomials, parenthetical
// part-of-plant notes. Matches image #43.
const COCOA_FACTS = {
  serving_size: "1 Scoop (8 g)",
  servings_per_container: 30,
  nutrients: BASE_NUTRIENTS,
  proprietary_blend: {
    amount: "5.6 g",
    daily_value: "**",
    ingredients:
      "French Roast Coffee (Coffea robusta) (bean) (60 mg Caffeine), Cocoa Powder, Caffeine Anhydrous (105 mg Caffeine), Cinnamon (Cinnamomum cassia) (bark), Turmeric (Curcuma longa) (root), Ginger (Zingiber officinale) (root), Panax ginseng Extract (stem & leaf), Shiitake Mushroom Extract (Lentinus edodes) (Whole Plant), Cordyceps sinensis Mushroom Extract (Mycelium), Organic Chaga Mushroom (Inonotus obliquus) (Fruit Tops), Maca (Lepidium meyenii) (root), Green Tea Extract (Camellia sinensis) (leaf), Green Coffee Bean Extract (Coffea robusta) (bean), Matcha (Camellia sinensis) (whole plant)",
  },
  footer_notes: STANDARD_FOOTER,
  other_ingredients:
    "Fibersol®-2 (soluble corn fiber). FIBERSOL® is a soluble dietary fiber produced by ADM / Matsutani LLC.",
};

// Hazelnut (Instant): simpler ingredient narrative + flavorings in
// Other Ingredients. Matches image #44.
const HAZELNUT_FACTS = {
  serving_size: "1 Scoop (8 g)",
  servings_per_container: 30,
  nutrients: BASE_NUTRIENTS,
  proprietary_blend: {
    amount: "5.6 g",
    daily_value: "**",
    ingredients:
      "French roast coffee (60 mg caffeine), Cocoa, Caffeine anhydrous (105 mg caffeine), Cinnamon bark, Turmeric root, Ginger root, Panax ginseng extract (aerial parts), Shiitake mushroom extract, Cordyceps mushroom extract, Organic chaga mushroom, Maca root, Green tea leaf extract, Green coffee bean extract, Matcha tea leaf",
  },
  footer_notes: STANDARD_FOOTER,
  other_ingredients:
    "Fibersol®-2 (soluble corn fiber), natural hazelnut flavor, stevia leaf extract, natural coffee flavor.",
};

// K-Cups: serving = 1 Pod, 24 per container. Otherwise mirrors the
// Hazelnut-style narrative + standard Fibersol footer. Matches image #45.
const KCUPS_FACTS = {
  serving_size: "1 Pod (8 g)",
  servings_per_container: 24,
  nutrients: BASE_NUTRIENTS,
  proprietary_blend: {
    amount: "5.6 g",
    daily_value: "**",
    ingredients:
      "French roast coffee (60 mg caffeine), Cocoa, Caffeine anhydrous (105 mg caffeine), Cinnamon bark, Turmeric root, Ginger root, Panax ginseng extract (aerial parts), Shiitake mushroom extract, Cordyceps mushroom extract, Organic chaga mushroom, Maca root, Green tea leaf extract, Green coffee bean extract, Matcha tea leaf",
  },
  footer_notes: STANDARD_FOOTER,
  other_ingredients:
    "Fibersol®-2 (soluble corn fiber). FIBERSOL® is a soluble dietary fiber produced by ADM / Matsutani LLC.",
};

// Variant lookups by product title + variant SKU (resilient to title
// rewrites by the admin).
const TARGETS = [
  {
    product_title_like: "Amazing Coffee",
    not_title_like: "K-Cup",
    variant_sku: "SC-INSTANTCO-COCOA",
    label: "Amazing Coffee — Cocoa French Roast",
    facts: COCOA_FACTS,
  },
  {
    product_title_like: "Amazing Coffee",
    not_title_like: "K-Cup",
    variant_sku: "SC-INSTANTCO-H-2",
    label: "Amazing Coffee — Hazelnut French Roast",
    facts: HAZELNUT_FACTS,
  },
  {
    product_title_like: "Amazing Coffee K-Cups",
    variant_sku: "SC-COFFEEPOD-NP24",
    label: "Amazing Coffee K-Cups — Cocoa",
    facts: KCUPS_FACTS,
  },
];

const dryRun = process.argv.includes("--dry-run");
console.log(dryRun ? "DRY RUN (no writes)\n" : "WRITING\n");

for (const t of TARGETS) {
  let q = admin
    .from("products")
    .select("id, title")
    .ilike("title", `%${t.product_title_like}%`);
  if (t.not_title_like) q = q.not("title", "ilike", `%${t.not_title_like}%`);
  const { data: prods } = await q;
  const product = (prods || [])[0];
  if (!product) {
    console.log(`✗ ${t.label} — no product match`);
    continue;
  }

  const { data: variant } = await admin
    .from("product_variants")
    .select("id, sku, title")
    .eq("product_id", product.id)
    .eq("sku", t.variant_sku)
    .maybeSingle();

  if (!variant) {
    console.log(`✗ ${t.label} — no variant match (sku=${t.variant_sku})`);
    continue;
  }

  console.log(`✓ ${t.label}`);
  console.log(`    product=${product.title} variant=${variant.title} (${variant.id})`);

  if (dryRun) continue;
  const { error } = await admin
    .from("product_variants")
    .update({ supplement_facts: t.facts })
    .eq("id", variant.id);
  if (error) console.log(`    write error: ${error.message}`);
}

console.log("\nDone.");
