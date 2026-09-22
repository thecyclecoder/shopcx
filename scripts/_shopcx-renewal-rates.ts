/** Cumulative ShopCX renewal outcomes since the engine started billing. */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SINCE="2026-09-19T00:00:00Z";
async function main(){
  const admin=createAdminClient();
  const { data: subs } = await admin.from("subscriptions").select("id, shopify_contract_id")
    .eq("workspace_id",WS).eq("billing_source","shopcx");
  const ids=(subs??[]).map(s=>s.id); const cids=new Set((subs??[]).map(s=>s.shopify_contract_id));
  const { data: o } = await admin.from("orders").select("total_cents, created_at")
    .eq("workspace_id",WS).in("subscription_id",ids).gte("created_at",SINCE);
  const charged=o?.length??0; const rev=(o??[]).reduce((t,x)=>t+(x.total_cents??0),0);
  // one decline per contract per day = one renewal attempt that failed
  const { data: pf } = await admin.from("payment_failures")
    .select("shopify_contract_id, created_at, attempt_type")
    .eq("workspace_id",WS).gte("created_at",SINCE);
  const initial=(pf??[]).filter(f=>cids.has(f.shopify_contract_id as string) && (f.attempt_type==="initial"||!f.attempt_type));
  const declinedAttempts=new Set(initial.map(f=>`${f.shopify_contract_id}:${String(f.created_at).slice(0,10)}`)).size;
  const attempts=charged+declinedAttempts;
  console.log(`ShopCX renewals since ${SINCE.slice(0,10)}`);
  console.log(`  charged          : ${charged}   ${`$${(rev/100).toFixed(2)}`}`);
  console.log(`  declined         : ${declinedAttempts}`);
  console.log(`  attempts         : ${attempts}`);
  console.log(`  decline rate     : ${attempts?((declinedAttempts/attempts)*100).toFixed(1):0}%`);
  // book baseline for comparison
  const { count: allDun } = await admin.from("dunning_cycles").select("*",{count:"exact",head:true})
    .eq("workspace_id",WS).gte("created_at","2026-08-22T00:00:00Z");
  console.log(`\n  book baseline: ${allDun} dunning cycles opened across ALL engines in the last 30d`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
