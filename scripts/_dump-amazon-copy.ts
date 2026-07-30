// Read-only: dump full title/bullets/description for a list of ASINs so we can
// craft accurate compliant rewrites.
import { createAdminClient } from "./_bootstrap";
import { spApiRequest } from "../src/lib/amazon/auth";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const MKT = "ATVPDKIKX0DER";

async function main() {
  const admin = createAdminClient();
  const asinArg = process.argv.slice(2);
  const { data: conns } = await admin
    .from("amazon_connections").select("id, seller_id").eq("workspace_id", WORKSPACE_ID);
  const connMap = new Map((conns || []).map((c) => [c.id, c.seller_id]));

  const { data: asins } = await admin
    .from("amazon_asins")
    .select("asin, sku, amazon_connection_id")
    .eq("workspace_id", WORKSPACE_ID)
    .in("asin", asinArg);

  for (const a of asins || []) {
    const sellerId = connMap.get(a.amazon_connection_id);
    const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId as string)}/${encodeURIComponent(
      a.sku as string,
    )}?marketplaceIds=${MKT}&includedData=attributes`;
    const res = await spApiRequest(a.amazon_connection_id, MKT, "GET", path);
    const j = await res.json();
    const attrs = j.attributes || {};
    console.log(`\n================= ${a.asin} (${a.sku}) productType=${j.summaries?.[0]?.productType || attrs.__pt || "?"} =================`);
    console.log("TITLE:", attrs.item_name?.[0]?.value || "(none)");
    (attrs.bullet_point || []).forEach((b: any, i: number) => console.log(`BULLET ${i + 1}:`, b.value));
    console.log("DESC:", attrs.product_description?.[0]?.value || "(none)");
  }
}
main().then(() => process.exit(0));
