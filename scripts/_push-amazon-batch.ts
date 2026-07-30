// Batch PATCH: push compliant copy (title + bullets [+ description]) to all
// active listings flagged in the audit for prohibited disease/detox/weight claims.
// Fetches each SKU's productType live so the PATCH validates. Idempotent-ish:
// re-running just re-sends the same compliant values.
import { createAdminClient } from "./_bootstrap";
import { spApiRequest } from "../src/lib/amazon/auth";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const MKT = "ATVPDKIKX0DER";
const enUS = (value: string) => ({ value, language_tag: "en_US", marketplace_id: MKT });

// ---- shared tabs copy ----
const tabsBullets = (flavor: string) => [
  "💪 15 REAL SUPERFOODS - Superfood Tabs are crafted with a thoughtfully selected blend of superfood ingredients to support a healthy, active lifestyle. This nutrient-rich effervescent drink makes it easy to bring superfoods into your daily routine and support your overall wellness.",
  "🌿 PLANT-BASED FORMULA - Made with 15 natural, plant-based superfood ingredients including chlorella, goji berry, green tea, ginger, elderberry, and dandelion. A simple, convenient way to nourish your body every day.",
  `⚡ ENERGY & ZERO SUGAR - Superfood Tabs contain no sugar and are lightly sweetened with stevia. Each tablet is just 5 calories, 0g of sugar, and less than 1g of carbs. Green tea provides natural caffeine — the ${flavor} flavor has 100mg per tablet.`,
  "🛡️ CLEAN & ALLERGEN-FRIENDLY - Gluten-Free, Soy-Free, Nut-Free, and Egg-Free. Free of all dairy products, making it a great choice for those who are lactose intolerant or have a dairy allergy. This product is also vegan and non-GMO.",
  "📍 MADE IN THE USA - Superfood Tabs are made in our Austin, Texas facility using high-quality ingredients from trusted suppliers. Please note that this product is not intended to diagnose, treat, cure, or prevent any disease and should not be used as a substitute for medical advice.",
];
const tabsDesc = (flavor: string, ingredients: string) =>
  `Superfood Tabs make it simple and convenient to bring real superfoods into your everyday routine. Each effervescent tablet dissolves into a refreshing ${flavor} drink, lightly sweetened with stevia — a delicious way to enjoy superfoods on the go, whether you're at home, at work, or on the road.\n\nEvery tablet is crafted with a blend of 15 plant-based superfood ingredients, including ${ingredients}. Superfood Tabs also provide essential electrolytes to help support everyday hydration.\n\nWith zero sugar, just 5 calories per tablet, and natural caffeine from green tea, Superfood Tabs are an easy way to support a healthy, active lifestyle. Simply drop a tablet into your water bottle and enjoy. For best results, we recommend enjoying Superfood Tabs daily as part of a balanced diet and regular exercise.\n\nMore than 150,000 customers have made Superfoods Company part of their wellness routine. Our product line also includes Super Amazing Coffee and Super Amazing Creamer. This product is not intended to diagnose, treat, cure, or prevent any disease.`;

const INGR_BERRY = "Burdock Root, Matcha, Elderberry, Milk Thistle, Pomegranate, Ginseng Root, Ginger Root, Chlorella, Dandelion, Green Tea, Beet Root, Wheat Grass, Goji Berry, Aloe Vera, and Lemon Balm";
const INGR_PM = "Burdock Root, Matcha, Elderberry, Milk Thistle, Pomegranate, Ginseng Root, Ginger Root, Chlorella, Dandelion, Green Tea, Beet Root, Wheat Grass, Goji Berry, Turmeric, and Lemon Balm";

// ---- shared coffee copy ----
const coffeeTail = [ // bullets 3,4,5 unchanged from live listings (already compliant)
  "⚡ HIGH ENERGY and ZERO SUGAR - Amazing Coffee do not contain sugar. It's naturally sugar-free and has no artificial sweeteners. Amazing Coffee has 165mg of caffeine per serving. The caffeine comes from green coffee and green tea, providing calm and steady energy!",
  "🛡️ PURELY SAFE - This product is Gluten-Free, Soy-Free, Nut-Free, and Egg-Free. It's also free of all dairy products, making it safe for those who are lactose intolerant or have a dairy allergy. Additionally, this product is vegan and non-GMO.",
  "📍 MADE IN THE USA - Proudly made in the USA at an FDA-registered facility with globally sourced ingredients. Please note that our products are not intended to diagnose, treat, cure, or prevent any disease and should not be used as a substitute for medical advice.",
];
const podsBullets = [
  "☕️ MORE THAN JUST COFFEE - Amazing Coffee is a nutrient-packed French roast crafted to support mental clarity, focus, and overall well-being.",
  "✨ BLEND OF 12 SUPERFOODS - This blend of mushrooms, turmeric, ginseng, ginger, cinnamon, and more supports alertness, focus, and energy. Our coffee doesn't use coffee grounds or filters, allowing 100% of the tasty nutrients to get into your cup.",
  ...coffeeTail,
];
const bagsBullets = [
  "☕️ MORE THAN JUST COFFEE - Amazing Coffee is a nutrient-packed French roast crafted to support focus, energy, and overall well-being.",
  "✨ BLEND OF 12 SUPERFOODS - This blend of mushrooms, turmeric, ginseng, ginger, cinnamon, and more supports alertness and focus. Our coffee doesn't use coffee grounds or filters, allowing 100% of the tasty nutrients to get into your cup.",
  ...coffeeTail,
];

type Update = { asin: string; title: string; bullets: string[]; description?: string };

const UPDATES: Update[] = [
  // ── Superfood Tabs variants ──
  {
    asin: "B0BJRX45JF", // Strawberry Lemonade, 60
    title: "Superfood Tabs by Superfoods Company - Superfood Effervescent Drink Tablets for Women & Men - 15 Real Superfoods, Green Tea & Chlorella - Vegan, Non-GMO, Zero Sugar - Strawberry Lemonade [60 Tablets]",
    bullets: tabsBullets("Strawberry Lemonade"),
    description: tabsDesc("Strawberry Lemonade", INGR_BERRY),
  },
  {
    asin: "B0BHLG5DGY", // Strawberry Lemonade, 30
    title: "Superfood Tabs by Superfoods Company - Superfood Effervescent Drink Tablets for Women & Men - 15 Real Superfoods, Green Tea & Chlorella - Vegan, Non-GMO, Zero Sugar - Strawberry Lemonade [30 Tablets]",
    bullets: tabsBullets("Strawberry Lemonade"),
    description: tabsDesc("Strawberry Lemonade", INGR_BERRY),
  },
  {
    asin: "B0BJQWTY6K", // Peach Mango, 60
    title: "Superfood Tabs by Superfoods Company - Superfood Effervescent Drink Tablets with 15 Superfoods - Supports Digestion & Energy - Vegan, Non-GMO, Zero Sugar - Peach Mango [60 Tablets]",
    bullets: tabsBullets("Peach Mango"),
    description: tabsDesc("Peach Mango", INGR_PM),
  },
  {
    asin: "B0BHL54P14", // Peach Mango, 30 (was "skinnytabs Anti-Bloat Cleanse")
    title: "Superfood Tabs by Superfoods Company - Superfood Effervescent Drink Tablets with 15 Superfoods - Supports Digestion & Energy - Vegan, Non-GMO, Zero Sugar - Peach Mango [30 Tablets]",
    bullets: tabsBullets("Peach Mango"),
    description: tabsDesc("Peach Mango", INGR_PM),
  },
  // ── Amazing Coffee pods ──
  {
    asin: "B0BLR2B936", // 24 pods
    title: "Superfoods Company Amazing Coffee - 12 Natural Superfoods - French Roast - Energy & Mental Clarity - Gluten Free, Non-GMO, Sugar Free, Vegan & Keto Friendly [24 Pods] [Cocoa]",
    bullets: podsBullets,
  },
  {
    asin: "B0BLQRD681", // 48 pods
    title: "Superfoods Company Amazing Coffee - 12 Natural Superfoods - French Roast - Energy & Mental Clarity - Gluten Free, Non-GMO, Sugar Free, Vegan & Keto Friendly [48 Pods] [Cocoa]",
    bullets: podsBullets,
  },
  // ── Amazing Coffee instant bags (Immunity in title + appetite/weight bullets) ──
  {
    asin: "B08C47SJ5B", // 60 servings
    title: "Superfoods Company | Amazing Coffee - Instant French Roast | Adaptogenic Mushrooms & Superfoods - Energy, Focus & Digestion - 60 Servings - Cocoa Flavor",
    bullets: bagsBullets,
  },
  {
    asin: "B08KYMN52M", // 30 servings
    title: "Superfoods Company | Amazing Coffee - Instant French Roast | Adaptogenic Mushrooms & Superfoods - Energy, Focus & Digestion - 30 Servings - Cocoa Flavor",
    bullets: bagsBullets,
  },
  // ── Amazing Creamer (Fat Burn / slim down) ──
  {
    asin: "B0DB8LM5YN",
    title: "Superfoods Company | Amazing Creamer - Cinnamon Roll - 2 Bag Bundle",
    bullets: [
      "Amazing Creamer® Fuels Your Glow, Brainpower & Daily Wellness",
      "Look and feel your best — with every scoop.",
      "Collagen, MCT Oil, and Hyaluronic Acid — a blend crafted for beauty and daily wellness.",
      "Proudly Made In The USA",
    ],
  },
];

async function main() {
  const admin = createAdminClient();
  const { data: conns } = await admin
    .from("amazon_connections").select("id, seller_id").eq("workspace_id", WORKSPACE_ID);
  const connMap = new Map((conns || []).map((c) => [c.id, c.seller_id]));

  const { data: asins } = await admin
    .from("amazon_asins")
    .select("asin, sku, amazon_connection_id")
    .eq("workspace_id", WORKSPACE_ID)
    .in("asin", UPDATES.map((u) => u.asin));
  const asinMap = new Map((asins || []).map((a) => [a.asin, a]));

  for (const u of UPDATES) {
    const a = asinMap.get(u.asin);
    if (!a) { console.log(`❌ ${u.asin}: no asin row`); continue; }
    const sellerId = connMap.get(a.amazon_connection_id) as string;
    const sku = a.sku as string;

    // fetch productType
    const getRes = await spApiRequest(
      a.amazon_connection_id, MKT, "GET",
      `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?marketplaceIds=${MKT}&includedData=summaries`,
    );
    const getJson = await getRes.json();
    const productType = getJson.summaries?.[0]?.productType;
    if (!productType) { console.log(`❌ ${u.asin}: no productType (${getRes.status})`); continue; }

    const patches: any[] = [
      { op: "replace", path: "/attributes/item_name", value: [enUS(u.title)] },
      { op: "replace", path: "/attributes/bullet_point", value: u.bullets.map(enUS) },
    ];
    if (u.description) {
      patches.push({ op: "replace", path: "/attributes/product_description", value: [enUS(u.description)] });
    }

    const res = await spApiRequest(
      a.amazon_connection_id, MKT, "PATCH",
      `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?marketplaceIds=${MKT}`,
      { productType, patches },
    );
    const body = await res.json();
    const status = body.status || res.status;
    const issues = (body.issues || []).map((i: any) => `${i.severity}:${i.message}`).join(" | ");
    console.log(`${status === "ACCEPTED" ? "✅" : "⚠️ "} ${u.asin} (${sku}) pt=${productType} → ${status}${issues ? "  ISSUES: " + issues : ""}  sub=${body.submissionId || "-"}`);
  }
}

main().then(() => process.exit(0));
