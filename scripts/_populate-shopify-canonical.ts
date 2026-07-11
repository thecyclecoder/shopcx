import { createAdminClient } from "./_bootstrap";
import { getShopifyCredentials } from "../src/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "../src/lib/shopify";
import { writeInventory, type InventoryRow } from "../src/lib/inventory/write";
const extId = (gid:string)=>String(gid).split("/").pop()||String(gid);
(async () => {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("id").not("shopify_access_token_encrypted","is",null).not("shopify_myshopify_domain","is",null);
  const wsId = ws![0].id;
  const { shop, accessToken } = await getShopifyCredentials(wsId);
  const rows: InventoryRow[] = [];
  let cursor:string|null=null;
  for (let page=0; page<20; page++){
    const after = cursor ? `, after: "${cursor}"` : "";
    const query = `{ products(first: 50${after}) { edges { cursor node { id variants(first: 100) { nodes { id sku inventoryQuantity } } } } pageInfo { hasNextPage } } }`;
    const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, { method:"POST", headers:{"X-Shopify-Access-Token":accessToken,"Content-Type":"application/json"}, body:JSON.stringify({query}) });
    if(!res.ok){ console.log("shopify err", res.status); break; }
    const data = await res.json();
    const edges = data?.data?.products?.edges||[];
    for (const e of edges){
      const pid = extId(e.node.id);
      // resolve our product uuid
      const { data: dbp } = await admin.from("products").select("id").eq("workspace_id",wsId).eq("shopify_product_id",pid).maybeSingle();
      for (const v of e.node.variants.nodes){
        const vid = extId(v.id);
        rows.push({ external_ref: vid, sku: v.sku ?? null, product_id: dbp?.id ?? null, variant_id: vid, on_hand: v.inventoryQuantity ?? 0 });
      }
      cursor = e.cursor;
    }
    if(!data?.data?.products?.pageInfo?.hasNextPage) break;
  }
  const today = new Date().toISOString().slice(0,10);
  const n = await writeInventory(admin, wsId, "shopify", rows, today);
  console.log(`wrote ${n} canonical shopify rows`);
  // reconcile crisis SKUs: canonical (fresh) vs Store B (stale)
  const { data: lv } = await admin.from("inventory_levels").select("variant_id, sku, on_hand").eq("workspace_id",wsId).eq("location","shopify").in("variant_id",["42614433448109","42614433480877","42614433513645"]);
  console.log("canonical fresh crisis variants:", lv);
})();
