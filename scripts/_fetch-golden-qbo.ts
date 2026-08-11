import { loadEnv } from "./_bootstrap"; loadEnv();
import * as fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient } from "../src/lib/supabase/admin";
import { qboFetch } from "../src/lib/quickbooks";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const DIR = "fixtures/shoptics-golden";

// Shoptics DB for the text-PK config tables missed earlier
const et = fs.readFileSync("/Users/admin/Projects/shoptics/.env.local","utf8"); const env:Record<string,string>={};
for(const l of et.split("\n")){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)env[m[1]]=m[2].replace(/^["']|["']$/g,"");}
const sh = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}});

async function main(){
  // 1) config tables (text PKs)
  for(const [t,pk] of [["qb_account_mappings","key"],["gateway_mappings","gateway_name"],["shipping_protection_products","shopify_product_id"]] as const){
    const { data } = await sh.from(t).select("*").order(pk,{ascending:true});
    fs.writeFileSync(`${DIR}/${t}.json`, JSON.stringify(data,null,2));
    console.log(`${t}: ${data?.length} rows`);
  }
  // 2) actual posted QBO entries per close
  const admin = createAdminClient();
  const closes = JSON.parse(fs.readFileSync(`${DIR}/month_end_closings.json`,"utf8"));
  fs.mkdirSync(`${DIR}/qbo-entries`,{recursive:true});
  for(const c of closes){
    const m = c.closing_month;
    const fetches: [string,string|null][] = [
      [`journalentry`, c.shopify_journal_entry_id],
      [`salesreceipt`, c.amazon_receipt_id],
      [`salesreceipt`, c.shopify_receipt_id],
      [`salesreceipt`, c.internal_receipt_id],
      [`inventoryadjustment`, c.inventory_adjustment_id],
    ];
    const out:Record<string,any> = { closing_month: m };
    for(const [entity,id] of fetches){
      if(!id) continue;
      try {
        const r = await qboFetch(WS, `${entity}/${id}`, { admin });
        const key = `${entity}_${id}`;
        out[key] = r[entity[0].toUpperCase()+entity.slice(1)] ?? r;
      } catch(e){ out[`${entity}_${id}_ERROR`] = e instanceof Error ? e.message : String(e); }
    }
    fs.writeFileSync(`${DIR}/qbo-entries/${m}.json`, JSON.stringify(out,null,2));
    const posted = Object.keys(out).filter(k=>k!=="closing_month"&&!k.endsWith("_ERROR"));
    console.log(`${m}: fetched ${posted.length} entries [${posted.join(", ")}]`);
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
