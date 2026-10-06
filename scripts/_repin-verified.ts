/**
 * Pin a subscription's date so the date actually RESOLVES to an unbilled cycle — verified.
 *
 * ⚠️ Pinning cycle N to date X makes X the END BOUNDARY of cycle N−1's window, and
 * `getBillingCycleForDate(X)` resolves a boundary to the EARLIER cycle. If N−1 is BILLED, the sub is
 * instantly stranded — by the very edit meant to help it. That is how `_pull-late-dates-earlier.ts`
 * re-stranded 3 subs on 2026-09-29 after fixing 14.
 *
 * So: pin, then VERIFY the lookup, and nudge forward a day at a time until it resolves to a live
 * cycle. Never trust the edit's own success.
 *
 *   npx tsx scripts/_repin-verified.ts [--apply]
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { reconcileShopcxDrift } from "../src/lib/commerce/shopcx-drift-reconciler";
import { getBillingCycleForDate, shopifySyncBillingSchedule, shopifySetNextBillingDate } from "../src/lib/commerce/shopify-subscription-client";

const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY=process.argv.includes("--apply");

async function main(){
  const admin=createAdminClient();
  const r=await reconcileShopcxDrift(WS,{});
  const stranded=r.drift.filter(d=>d.kind==="stranded");
  console.log(`stranded: ${stranded.length}`);

  for(const d of stranded){
    const {data:sub}=await admin.from("subscriptions").select("id,next_billing_date")
      .eq("workspace_id",WS).eq("shopify_contract_id",d.contractId).maybeSingle();
    if(!sub?.next_billing_date){ console.log(`  ✗ ${d.contractId}: no date`); continue; }
    if(!APPLY){ console.log(`  [dry] ${d.contractId} at ${String(sub.next_billing_date).slice(0,10)}`); continue; }

    // Walk forward a day at a time until the date lands in a cycle that is genuinely live.
    let target=new Date(sub.next_billing_date);
    const floor=new Date(Date.now()+86400000);
    if(target<floor) target=floor;
    let ok=false;
    for(let i=0;i<40;i++){
      const cyc=await getBillingCycleForDate(WS,d.contractId,target.toISOString());
      if(cyc.success&&cyc.cycle&&cyc.cycle.status!=="BILLED"&&!cyc.cycle.skipped){
        await shopifySetNextBillingDate(WS,d.contractId,target.toISOString());
        await admin.from("subscriptions").update({next_billing_date:target.toISOString(),updated_at:new Date().toISOString()}).eq("id",sub.id);
        // re-read: the write itself must not have moved the boundary under us
        const check=await getBillingCycleForDate(WS,d.contractId,target.toISOString());
        if(check.cycle&&check.cycle.status!=="BILLED"&&!check.cycle.skipped){
          console.log(`  ${d.contractId} → ${target.toISOString().slice(0,10)}  cycle#${check.cycle.index} ${check.cycle.status} ✅`);
          ok=true; break;
        }
      }
      target=new Date(target.getTime()+86400000);
    }
    if(!ok) console.log(`  ✗ ${d.contractId}: no live cycle within 40 days`);
  }
  const after=await reconcileShopcxDrift(WS,{});
  console.log(`\ndrift after: ${after.drift.length}/${after.checked}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
