// Fix remaining "Detox Cleanse" titles on the variation parent + inactive
// children. Parent has a title only (no bullets/desc). Inactive children have
// empty attributes — attempt a title contribution and report the API verdict.
import { createAdminClient } from "./_bootstrap";
import { spApiRequest } from "../src/lib/amazon/auth";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const MKT = "ATVPDKIKX0DER";
const enUS = (value: string) => ({ value, language_tag: "en_US", marketplace_id: MKT });

const UPDATES: { asin: string; title: string }[] = [
  {
    asin: "B0BMNW5847", // parent L1-3K2R-600C
    title: "Superfood Tabs by Superfoods Company - Superfood Effervescent Drink Tablets for Women & Men - 15 Real Superfoods, Green Tea & Chlorella - Vegan, Non-GMO, Zero Sugar - Mixed Berry [30 Tablets]",
  },
  {
    asin: "B0F88PW82S", // inactive
    title: "Superfood Tabs by Superfoods Company - Fizzy Superfood Effervescent Drink Tablets - 15 Real Superfoods - Vegan, Non-GMO, Zero Sugar - Mixed Berry",
  },
  {
    asin: "B07N5LSWHV", // inactive
    title: "Superfood Tabs by Superfoods Company - Superfood Effervescent Drink Tablets for Women & Men - 15 Real Superfoods - Vegan, Non-GMO, Zero Sugar - Mixed Berry",
  },
];

async function main() {
  const admin = createAdminClient();
  const { data: conns } = await admin
    .from("amazon_connections").select("id, seller_id").eq("workspace_id", WORKSPACE_ID);
  const connMap = new Map((conns || []).map((c) => [c.id, c.seller_id]));
  const { data: asins } = await admin
    .from("amazon_asins").select("asin, sku, amazon_connection_id")
    .eq("workspace_id", WORKSPACE_ID).in("asin", UPDATES.map((u) => u.asin));
  const asinMap = new Map((asins || []).map((a) => [a.asin, a]));

  for (const u of UPDATES) {
    const a = asinMap.get(u.asin);
    if (!a) { console.log(`❌ ${u.asin}: no asin row`); continue; }
    const sellerId = connMap.get(a.amazon_connection_id) as string;
    const sku = a.sku as string;

    const getRes = await spApiRequest(
      a.amazon_connection_id, MKT, "GET",
      `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?marketplaceIds=${MKT}&includedData=summaries`,
    );
    const getJson = await getRes.json();
    const productType = getJson.summaries?.[0]?.productType || "NUTRITIONAL_SUPPLEMENT";

    const res = await spApiRequest(
      a.amazon_connection_id, MKT, "PATCH",
      `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?marketplaceIds=${MKT}`,
      { productType, patches: [{ op: "replace", path: "/attributes/item_name", value: [enUS(u.title)] }] },
    );
    const body = await res.json();
    const status = body.status || res.status;
    const issues = (body.issues || []).map((i: any) => `${i.severity}:${i.message}`).join(" | ");
    console.log(`${status === "ACCEPTED" ? "✅" : "⚠️ "} ${u.asin} (${sku}) pt=${productType} → ${status}${issues ? "  ISSUES: " + issues : ""}  sub=${body.submissionId || "-"}`);
  }
}
main().then(() => process.exit(0));
