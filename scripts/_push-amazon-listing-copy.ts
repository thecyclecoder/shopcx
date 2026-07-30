// One-off: PATCH the Amazon listing copy (title + bullets + description) to
// remove prohibited disease/detox claims flagged in Amazon's enforcement.
// ASIN B08C1R4HG3 / SKU AMZ-TABS-2F / productType NUTRITIONAL_SUPPLEMENT.
import { createAdminClient } from "./_bootstrap";
import { spApiRequest } from "../src/lib/amazon/auth";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods
const ASIN = "B08C1R4HG3";
const MKT = "ATVPDKIKX0DER";

const TITLE =
  "Superfood Tabs by Superfoods Company - Superfood Effervescent Drink Tablets for Women & Men - 15 Real Superfoods, Green Tea & Chlorella - Vegan, Non-GMO, Zero Sugar - Mixed Berry [60 Tablets]";

const BULLETS = [
  "💪 15 REAL SUPERFOODS - Superfood Tabs are crafted with a thoughtfully selected blend of superfood ingredients to support a healthy, active lifestyle. This nutrient-rich effervescent drink makes it easy to bring superfoods into your daily routine and support your overall wellness.",
  "🌿 PLANT-BASED FORMULA - Made with 15 natural, plant-based superfood ingredients including chlorella, goji berry, green tea, ginger, elderberry, and dandelion. A simple, convenient way to nourish your body every day.",
  "⚡ ENERGY & ZERO SUGAR - Superfood Tabs contain no sugar and are lightly sweetened with stevia. Each tablet is just 5 calories with 0g of sugar. Green tea provides natural caffeine — the Mixed Berry flavor has 100mg per tablet.",
  "🛡️ CLEAN & ALLERGEN-FRIENDLY - Gluten-Free, Soy-Free, Nut-Free, and Egg-Free. Free of all dairy products, making it a great choice for those who are lactose intolerant or have a dairy allergy. This product is also vegan and non-GMO.",
  "📍 MADE IN THE USA - Superfood Tabs are made in our Austin, Texas facility using high-quality ingredients from trusted suppliers. Please note that this product is not intended to diagnose, treat, cure, or prevent any disease and should not be used as a substitute for medical advice.",
];

const DESCRIPTION =
  "Superfood Tabs make it simple and convenient to bring real superfoods into your everyday routine. Each effervescent tablet dissolves into a refreshing Mixed Berry drink, lightly sweetened with stevia — a delicious way to enjoy superfoods on the go, whether you're at home, at work, or on the road.\n\nEvery tablet is crafted with a blend of 15 plant-based superfood ingredients, including Burdock Root, Matcha, Elderberry, Milk Thistle, Pomegranate, Ginseng Root, Ginger Root, Chlorella, Dandelion, Green Tea, Beet Root, Wheat Grass, Goji Berry, Aloe Vera, and Lemon Balm. Superfood Tabs also provide essential electrolytes to help support everyday hydration.\n\nWith zero sugar, just 5 calories per tablet, and natural caffeine from green tea, Superfood Tabs are an easy way to support a healthy, active lifestyle. Simply drop a tablet into your water bottle and enjoy. For best results, we recommend enjoying Superfood Tabs daily as part of a balanced diet and regular exercise.\n\nMore than 150,000 customers have made Superfoods Company part of their wellness routine. Our product line also includes Super Amazing Coffee and Super Amazing Creamer. This product is not intended to diagnose, treat, cure, or prevent any disease.";

const enUS = (value: string) => ({ value, language_tag: "en_US", marketplace_id: MKT });

async function main() {
  const admin = createAdminClient();

  const { data: asin } = await admin
    .from("amazon_asins")
    .select("sku, amazon_connection_id")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("asin", ASIN)
    .single();

  const { data: conn } = await admin
    .from("amazon_connections")
    .select("id, seller_id, marketplace_id")
    .eq("id", asin!.amazon_connection_id)
    .single();

  const sellerId = conn!.seller_id;
  const sku = asin!.sku as string;

  const body = {
    productType: "NUTRITIONAL_SUPPLEMENT",
    patches: [
      { op: "replace", path: "/attributes/item_name", value: [enUS(TITLE)] },
      { op: "replace", path: "/attributes/bullet_point", value: BULLETS.map(enUS) },
      { op: "replace", path: "/attributes/product_description", value: [enUS(DESCRIPTION)] },
    ],
  };

  const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(
    sku,
  )}?marketplaceIds=${MKT}`;

  console.log("PATCH", path);
  const res = await spApiRequest(conn!.id, MKT, "PATCH", path, body);
  const text = await res.text();
  console.log("status:", res.status);
  console.log(text);
}

main().then(() => process.exit(0));
