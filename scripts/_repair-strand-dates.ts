/**
 * Second-pass repair: put each stranded sub on its CORRECT date, not its cycle's end date.
 *
 * ⚠️ `billingAttemptExpectedDate` is the cycle END. The first repair used it as the target date, so
 * every customer was pushed to the far edge of their next cycle — mean +40 days, worst +140 on a
 * 28-day cadence. But a cycle can be pinned anywhere INSIDE its window, and the window START is
 * usually exactly one cadence after the customer's last charge: their real date.
 *
 * Target = last charge + one cadence, clamped into [window start, window end] and never in the past.
 *
 *   npx tsx scripts/_repair-strand-dates.ts [--apply]
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getBillingCycleForDate, shopifySyncBillingSchedule, shopifySetNextBillingDate } from "../src/lib/commerce/shopify-subscription-client";

const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY=process.argv.includes("--apply");
const cadDays=(i:string|null,n:number|null)=>{const x=String(i??"month").toLowerCase();const k=n??1;return x==="week"?7*k:x==="day"?k:x==="year"?365*k:30*k;};

async function main(){
  const admin=createAdminClient();
  const {data:subs}=await admin.from("subscriptions")
    .select("id,shopify_contract_id,next_billing_date,billing_interval,billing_interval_count")
    .eq("workspace_id",WS).eq("billing_source","shopcx").neq("status","cancelled")
    .gte("updated_at","2026-09-28T00:00:00Z");

  let improved=0, already=0, failed=0, savedDays=0;
  for(const s of subs??[]){
    const {data:last}=await admin.from("orders").select("created_at")
      .eq("workspace_id",WS).eq("subscription_id",s.id).order("created_at",{ascending:false}).limit(1);
    if(!last?.[0]) continue;
    const cad=cadDays(s.billing_interval,s.billing_interval_count);
    const current=new Date(s.next_billing_date!);
    const gap=Math.round((current.getTime()-new Date(last[0].created_at as string).getTime())/86400000);
    if(gap<=cad*1.2){ already++; continue; }

    const cyc=await getBillingCycleForDate(WS,s.shopify_contract_id,s.next_billing_date!);
    if(!cyc.success||!cyc.cycle){ failed++; continue; }

    const want=new Date(new Date(last[0].created_at as string).getTime()+cad*86400000);
    const lo=new Date(new Date(cyc.cycle.startAt).getTime()+60_000);      // just inside the window
    const hi=new Date(new Date(cyc.cycle.endAt).getTime()-60_000);
    const floor=new Date(Date.now()+86400000);                            // never in the past
    let target=want<lo?lo:want>hi?hi:want;
    if(target<floor) target=floor>hi?hi:floor;
    const better=Math.round((current.getTime()-target.getTime())/86400000);
    if(better<=0){ already++; continue; }

    if(!APPLY){ console.log(`  [dry] ${s.shopify_contract_id}  ${String(s.next_billing_date).slice(0,10)} → ${target.toISOString().slice(0,10)}  (${better}d earlier, cycle#${cyc.cycle.index})`); improved++; savedDays+=better; continue; }

    const pin=await shopifySyncBillingSchedule(WS,s.shopify_contract_id,{firstDate:target.toISOString(),startIndex:cyc.cycle.index,cycles:1});
    if(!pin.success||!pin.pinned){ failed++; console.log(`  ✗ ${s.shopify_contract_id}: ${pin.stoppedAt??pin.error}`); continue; }
    await shopifySetNextBillingDate(WS,s.shopify_contract_id,target.toISOString());
    const { error }=await admin.from("subscriptions")
      .update({next_billing_date:target.toISOString(),updated_at:new Date().toISOString()}).eq("id",s.id);
    if(error){ failed++; continue; }
    const check=await getBillingCycleForDate(WS,s.shopify_contract_id,target.toISOString());
    if(check.cycle && check.cycle.status!=="BILLED" && !check.cycle.skipped){
      improved++; savedDays+=better;
      if(improved<=5||improved%25===0) console.log(`  ${s.shopify_contract_id} → ${target.toISOString().slice(0,10)}  (${better}d earlier) [${improved}]`);
    } else { failed++; console.log(`  ✗ ${s.shopify_contract_id}: re-stranded`); }
  }
  console.log(`\n${APPLY?"improved":"would improve"} ${improved}   already correct ${already}   failed ${failed}`);
  console.log(`days of delay removed: ${savedDays}  (mean ${improved?(savedDays/improved).toFixed(1):0}d per customer)`);
  if(!APPLY) console.log("dry run — pass --apply");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
