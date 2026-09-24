import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { reconcileShopcxDrift } from "../src/lib/commerce/shopcx-drift-reconciler";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const admin=createAdminClient();
  const {data:subs}=await admin.from("subscriptions").select("id,customer_id,shopify_contract_id")
    .eq("workspace_id",WS).eq("billing_source","shopcx").neq("status","cancelled");
  const cust=[...new Set((subs??[]).map(s=>s.customer_id).filter(Boolean))] as string[];
  // double-charge check across the WHOLE renewal period, per customer per day
  const {data:o}=await admin.from("orders").select("customer_id,created_at,total_cents,order_number,subscription_id")
    .eq("workspace_id",WS).in("customer_id",cust).gte("created_at","2026-09-19T00:00:00Z");
  // ⚠️ Count per SUBSCRIPTION-day, not per customer-day. A customer can legitimately hold two
  // subscriptions — and during a migration one of them may still be on Appstle while the other is
  // on ShopCX, so they bill from different crons at different times for different amounts. That is
  // two correct charges, not a double charge. Measured 2026-09-24: the only per-customer hit in the
  // whole period was exactly that shape (one Appstle sub at 08:02, one shopcx sub at 10:00).
  const perDay=new Map<string,string[]>();
  for(const x of o??[]) {
    if(!x.subscription_id) continue;
    const k=`${x.subscription_id}:${String(x.created_at).slice(0,10)}`;
    perDay.set(k,[...(perDay.get(k)??[]), x.order_number as string]);
  }
  const dbl=[...perDay.entries()].filter(([,v])=>v.length>1);
  console.log(`orders for shopcx customers since 09-19: ${o?.length}`);
  console.log(`subscription-days with >1 order: ${dbl.length} ${dbl.length?"⚠️ DOUBLE CHARGE":"✅ no double charge in the whole period"}`);
  for(const [k,v] of dbl) console.log(`  ${k}: ${v.join(", ")}`);

  const d=await reconcileShopcxDrift(WS,{});
  console.log(`\ndrift: ${d.drift.length}/${d.checked}`);
  for(const x of d.drift.slice(0,6)) console.log(`  [${x.kind}] ${x.contractId}: ${x.detail.slice(0,80)}`);

  const {count:appstle}=await admin.from("subscriptions").select("*",{count:"exact",head:true})
    .eq("workspace_id",WS).eq("status","active").eq("billing_source","appstle");
  console.log(`\nshopcx active: ${subs?.length}   appstle active remaining: ${appstle}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
