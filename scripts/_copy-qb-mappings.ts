import { loadEnv } from "./_bootstrap"; loadEnv();
import * as fs from "fs"; import * as crypto from "crypto";
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const DIR = "fixtures/shoptics-golden";
const admin = createAdminClient();

// table -> [target, columns to copy, conflict target]
const SPEC: [string,string,string[],string][] = [
  ["products","qb_items",["id","quickbooks_id","quickbooks_name","sku","category","unit_cost","reorder_point","lead_time_days","active","item_type","bundle_id","bundle_quantity","product_category","revenue_account_id","revenue_account_name","image_url","created_at","updated_at"],"workspace_id,quickbooks_id"],
  ["product_bom","qb_item_bom",["id","parent_id","component_id","quantity","created_at"],"workspace_id,parent_id,component_id"],
  ["sku_mappings","qb_sku_mappings",["id","product_id","external_id","source","label","unit_multiplier","active","created_at","updated_at"],"workspace_id,external_id,source"],
  ["external_skus","qb_external_skus",["id","external_id","source","label","title","image_url","price","parent_asin","item_type","quantity","seller_sku","status","last_seen_at","created_at","updated_at"],"workspace_id,external_id,source"],
  ["qb_account_mappings","qb_account_mappings",["key","qb_id","qb_name","updated_at"],"workspace_id,key"],
  ["gateway_mappings","qb_gateway_mappings",["gateway_name","processor"],"workspace_id,gateway_name"],
  ["shipping_protection_products","qb_shipping_protection_products",["shopify_product_id","title","created_at"],"workspace_id,shopify_product_id"],
  ["manual_inventory","qb_manual_inventory",["id","product_id","quantity","location","note","active","created_at","updated_at"],"id"],
];
const pick = (row:any, cols:string[]) => Object.fromEntries(cols.filter(c=>c in row).map(c=>[c,row[c]]));
const checksum = (rows:any[], cols:string[]) => {
  const norm = rows.map(r=>cols.filter(c=>c!=="created_at"&&c!=="updated_at"&&c!=="last_seen_at").map(c=>String(r[c]??"")).join("|")).sort();
  return crypto.createHash("sha256").update(norm.join("\n")).digest("hex").slice(0,12);
};
async function main(){
  console.log("table".padEnd(32),"src","->","dst","chk_src","chk_dst","OK");
  for(const [srcFile,dst,cols,conflict] of SPEC){
    const src = JSON.parse(fs.readFileSync(`${DIR}/${srcFile}.json`,"utf8"));
    const rows = src.map((r:any)=>({...pick(r,cols), workspace_id: WS}));
    // insert in batches
    for(let i=0;i<rows.length;i+=200){
      const { error } = await admin.from(dst).upsert(rows.slice(i,i+200), { onConflict: conflict });
      if(error){ console.log(`  ${dst} INSERT ERR:`, error.message); break; }
    }
    const { data: got } = await admin.from(dst).select("*").eq("workspace_id",WS);
    const chkSrc = checksum(src, cols);
    const chkDst = checksum(got??[], cols);
    const ok = (got?.length===src.length) && (chkSrc===chkDst);
    console.log(dst.padEnd(32), String(src.length).padStart(3), "->", String(got?.length??0).padStart(3), chkSrc, chkDst, ok?"✓":"✗ MISMATCH");
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
