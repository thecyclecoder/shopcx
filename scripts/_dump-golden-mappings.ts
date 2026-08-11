import * as fs from "fs";
import { createClient } from "@supabase/supabase-js";
const envText = fs.readFileSync("/Users/admin/Projects/shoptics/.env.local", "utf8");
const env: Record<string,string> = {};
for (const l of envText.split("\n")){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)env[m[1]]=m[2].replace(/^["']|["']$/g,"");}
const sh = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
const DIR = "fixtures/shoptics-golden";
// Crown-jewel mapping/config tables — the losslessly-ported data.
const TABLES = ["products","product_bom","sku_mappings","external_skus","qb_account_mappings",
  "gateway_mappings","shipping_protection_products","manual_inventory","kit_mappings",
  "month_end_closings","payment_processor_summaries"];
async function main(){
  const summary: Record<string,number> = {};
  for(const t of TABLES){
    const { data, error } = await sh.from(t).select("*").order("id",{ascending:true});
    if(error){ console.log(`${t}: ERR ${error.message}`); continue; }
    fs.writeFileSync(`${DIR}/${t}.json`, JSON.stringify(data,null,2));
    summary[t] = data?.length ?? 0;
    console.log(`${t.padEnd(30)} ${data?.length} rows → ${DIR}/${t}.json`);
  }
  fs.writeFileSync(`${DIR}/_manifest.json`, JSON.stringify({ capturedFromRealm: "shoptics logistics DB", tables: summary }, null, 2));
}
main().catch(e=>{console.error(e);process.exit(1);});
