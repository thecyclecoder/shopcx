/**
 * Move a sub's billing date to the EARLIEST its cycle window allows, when it is sitting late.
 *
 * ⚠️ A sub can be in the RIGHT cycle and still be dated a month too late — the retime pins to
 * whatever date it was handed, and `billingAttemptExpectedDate` is the cycle END. Nothing flags
 * this: the drift reconciler sees an unbilled cycle (not stranded) and a date that matches ours
 * (no drift). It is only visible by comparing against the customer's own cadence.
 *
 * Target = last charge + one cadence, clamped into the cycle window, never in the past.
 *
 *   npx tsx scripts/_pull-late-dates-earlier.ts [--apply]
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
  const subs:any[]=[];
  for(let f=0;;f+=1000){
    const {data}=await admin.from("subscriptions")
      .select("id,shopify_contract_id,next_billing_date,billing_interval,billing_interval_count")
      .eq("workspace_id",WS).eq("billing_source","shopcx").eq("status","active").range(f,f+999);
    if(!data?.length)break; subs.push(...data); if(data.length<1000)break;
  }
  let moved=0, fine=0, skipped=0, saved=0;
  for(const s of subs){
    const {data:last}=await admin.from("orders").select("created_at")
      .eq("workspace_id",WS).eq("subscription_id",s.id).order("created_at",{ascending:false}).limit(1);
    if(!last?.[0]){ skipped++; continue; }
    const c=cadDays(s.billing_interval,s.billing_interval_count);
    const lastAt=new Date(last[0].created_at as string);
    const current=new Date(s.next_billing_date!);
    if(Math.round((current.getTime()-lastAt.getTime())/86400000)-c <= 1){ fine++; continue; }

    const cyc=await getBillingCycleForDate(WS,s.shopify_contract_id,s.next_billing_date!);
    if(!cyc.success||!cyc.cycle||cyc.cycle.status==="BILLED"||cyc.cycle.skipped){ skipped++; continue; }
    const want=new Date(lastAt.getTime()+c*86400000);
    const lo=new Date(new Date(cyc.cycle.startAt).getTime()+60_000);
    const hi=new Date(new Date(cyc.cycle.endAt).getTime()-60_000);
    const floor=new Date(Date.now()+86400000);
    let target=want<lo?lo:want>hi?hi:want;
    if(target<floor) target=floor>hi?hi:floor;
    const better=Math.round((current.getTime()-target.getTime())/86400000);
    if(better<=1){ fine++; continue; }

    if(!APPLY){ console.log(`  [dry] ${s.shopify_contract_id}  ${String(s.next_billing_date).slice(0,10)} → ${target.toISOString().slice(0,10)}  (${better}d earlier)`); moved++; saved+=better; continue; }
    const pin=await shopifySyncBillingSchedule(WS,s.shopify_contract_id,{firstDate:target.toISOString(),startIndex:cyc.cycle.index,cycles:1});
    if(!pin.success||!pin.pinned){ skipped++; console.log(`  ✗ ${s.shopify_contract_id}: ${pin.stoppedAt??pin.error}`); continue; }
    await shopifySetNextBillingDate(WS,s.shopify_contract_id,target.toISOString());
    await admin.from("subscriptions").update({next_billing_date:target.toISOString(),updated_at:new Date().toISOString()}).eq("id",s.id);
    moved++; saved+=better;
    console.log(`  ${s.shopify_contract_id} → ${target.toISOString().slice(0,10)} (${better}d earlier)`);
  }
  console.log(`\n${APPLY?"moved":"would move"} ${moved}   already correct ${fine}   skipped ${skipped}   days recovered ${saved}`);
  if(!APPLY) console.log("dry run — pass --apply");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
