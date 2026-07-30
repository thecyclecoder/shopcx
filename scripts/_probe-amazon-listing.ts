// Read-only probe: find the connection + SKU for a given ASIN and pull
// the current SP-API listing content so we can rewrite the copy accurately.
import { createAdminClient } from "./_bootstrap";
import { spApiRequest } from "../src/lib/amazon/auth";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods
const ASIN = process.argv[2] || "B08C1R4HG3";

async function main() {
  const admin = createAdminClient();

  const { data: conns } = await admin
    .from("amazon_connections")
    .select("id, seller_id, marketplace_id, seller_name, is_active")
    .eq("workspace_id", WORKSPACE_ID);
  console.log("connections:", JSON.stringify(conns, null, 2));

  const { data: asins } = await admin
    .from("amazon_asins")
    .select("id, asin, sku, title, status, amazon_connection_id")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("asin", ASIN);
  console.log("asin rows:", JSON.stringify(asins, null, 2));

  if (!asins?.length || !conns?.length) {
    console.log("Missing connection or asin row — stopping.");
    return;
  }

  const asin = asins[0];
  const conn = conns.find((c) => c.id === asin.amazon_connection_id) || conns[0];
  const sellerId = conn.seller_id;
  const sku = asin.sku;
  const mkt = conn.marketplace_id;

  if (!sku) {
    console.log("No seller SKU stored for this ASIN — cannot address Listings API.");
    return;
  }

  const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(
    sku,
  )}?marketplaceIds=${mkt}&includedData=summaries,attributes,issues,offers`;
  console.log("\nGET", path, "\n");
  try {
    const res = await spApiRequest(conn.id, mkt, "GET", path);
    const text = await res.text();
    console.log("status:", res.status);
    console.log(text.slice(0, 12000));
  } catch (e) {
    console.log("SP-API error:", (e as Error).message);
  }
}

main().then(() => process.exit(0));
