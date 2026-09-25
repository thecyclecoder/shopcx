/**
 * Roll the billing date forward for subs left stalled by a closed dunning cycle.
 *
 * A closed (exhausted/skipped) cycle that never released `next_billing_date` leaves the sub
 * unbillable forever: the cycle-charge claim is keyed on the frozen due date, so the renewal cron
 * selects it, cannot claim, and skips — every day, with no further charge and no cancellation.
 *
 *   npx tsx scripts/_repair-stalled-dunning.ts [--apply]
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { rollForwardToFutureBillingDate } from "../src/lib/dunning";
import { shopifyRetimeContract } from "../src/lib/commerce/shopify-subscription-client";

const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY=process.argv.includes("--apply");
const OPEN=["active","rotating","retrying","skipped","paused"];

async function main(){
  const admin=createAdminClient();
  const {data:subs}=await admin.from("subscriptions")
    .select("id,shopify_contract_id,billing_source,status,next_billing_date,billing_interval,billing_interval_count")
    .eq("workspace_id",WS).eq("status","active").lt("next_billing_date",new Date().toISOString());
  console.log(`active subs with a past-due date: ${subs?.length}`);

  let stalled=0, fixed=0;
  for(const s of subs??[]){
    const {data:cycles}=await admin.from("dunning_cycles").select("status")
      .eq("workspace_id",WS).eq("shopify_contract_id",s.shopify_contract_id);
    if(!cycles?.length) continue;                                   // never dunned — a different problem
    if(cycles.some(c=>OPEN.includes(c.status as string))) continue;  // still being worked
    stalled++;
    const next=rollForwardToFutureBillingDate(
      new Date(s.next_billing_date!), s.billing_interval??"month", s.billing_interval_count??1);
    console.log(`${APPLY?"":"[dry] "}${s.shopify_contract_id} (${s.billing_source})  ${String(s.next_billing_date).slice(0,10)} → ${next.toISOString().slice(0,10)}  [cycles: ${cycles.map(c=>c.status).join(",")}]`);
    if(!APPLY) continue;
    const { error }=await admin.from("subscriptions")
      .update({next_billing_date:next.toISOString(),updated_at:new Date().toISOString()}).eq("id",s.id);
    if(error){ console.log(`   ✗ ${error.message}`); continue; }
    if(s.billing_source==="shopcx"){
      const r=await shopifyRetimeContract(WS,s.shopify_contract_id,next.toISOString());
      if(r.stranded) console.log(`   ⚠️ new date lands in a spent cycle — needs a manual re-pin`);
      else if(!r.success) console.log(`   ⚠️ retime failed: ${r.error}`);
    }
    fixed++;
  }
  console.log(`\nstalled: ${stalled}   repaired: ${fixed}`);
  if(!APPLY) console.log("dry run — pass --apply");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
