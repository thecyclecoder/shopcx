/**
 * Migrate the Appstle subs still held by customers already on ShopCX, so nobody bills from two
 * engines at once.
 *
 * Waves select by DUE DATE, which cut multi-subscription customers in half. Nothing breaks outright
 * — their subs already billed on separate dates — but a customer failing payment on both engines
 * would be dunned twice by two cycles that know nothing of each other.
 *
 *   npx tsx scripts/_heal-split-customers.ts [--apply]
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const RULE="ed8ae5b4-aba9-4ad6-9e1f-2ef504819f19";
const APPLY=process.argv.includes("--apply");
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

async function main(){
  const admin=createAdminClient();
  const rows:any[]=[];
  for(let f=0;;f+=1000){
    const {data}=await admin.from("subscriptions").select("id,customer_id,shopify_contract_id,billing_source,status")
      .eq("workspace_id",WS).neq("status","cancelled").range(f,f+999);
    if(!data?.length)break; rows.push(...data); if(data.length<1000)break;
  }
  const byCust=new Map<string,any[]>();
  for(const r of rows){ if(r.customer_id) byCust.set(r.customer_id,[...(byCust.get(r.customer_id)??[]),r]); }

  // only appstle+shopcx — an internal sub alongside is the CEO's preferred end state, not a defect
  const targets:any[]=[];
  for(const [,v] of byCust){
    const engines=new Set(v.map(x=>x.billing_source));
    if(!(engines.has("shopcx")&&engines.has("appstle"))) continue;
    targets.push(...v.filter(x=>x.billing_source==="appstle"));
  }
  console.log(`appstle subs held by customers already on ShopCX: ${targets.length}`);

  const { loadPricingContext, executeMigration } = await import("../src/lib/commerce/shopify-subscription-migrate");
  const { snapshotAppstleContract } = await import("../src/lib/appstle-snapshot");
  const ctx = await loadPricingContext(WS, RULE);
  const outcomes:Record<string,number>={};

  for(const [n,t] of targets.entries()){
    if(!APPLY){ console.log(`  [dry] ${t.shopify_contract_id} (${t.status})`); continue; }
    const snap=await snapshotAppstleContract(WS,t.shopify_contract_id,t.id);
    if(!snap.ok){ console.log(`  [${n+1}] ${t.shopify_contract_id} ✗ snapshot: ${snap.error}`); outcomes.snapshot=(outcomes.snapshot??0)+1; continue; }
    const r=await executeMigration(WS,t.shopify_contract_id,ctx,{completeSwap:true});
    outcomes[r.ok?"swapped":r.stage]=(outcomes[r.ok?"swapped":r.stage]??0)+1;
    console.log(`  [${n+1}/${targets.length}] ${t.shopify_contract_id} → ${r.ok?"SWAPPED":"✗ "+r.stage+": "+String(r.error).slice(0,80)}`);
    await sleep(1200);
  }
  if(APPLY) console.log(`\noutcomes: ${JSON.stringify(outcomes)}`);
  else console.log("\ndry run — pass --apply");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
